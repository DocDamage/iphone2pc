"""Persistent recovery queue worker and dual-destination copier."""

from app_core import *
from app_device import *
from app_media_service import *
from app_transfer_router import *

def _queue_target_folder(root: str, structure_mode: str, track: dict) -> str:
    if structure_mode == "artist":
        return os.path.join(root, safe_component(str(track.get("artist") or ""), "Unknown Artist"))
    if structure_mode == "album":
        return os.path.join(root, safe_component(str(track.get("album") or ""), "Unknown Album"))
    return root


def _unused_or_matching_path(candidate: str, expected_hash: str) -> tuple[str, bool]:
    if not os.path.exists(candidate):
        return candidate, False
    try:
        if os.path.isfile(candidate) and sha256_file(candidate) == expected_hash:
            return candidate, True
    except OSError:
        pass
    base, extension = os.path.splitext(candidate)
    counter = 1
    while os.path.exists(f"{base}_{counter}{extension}"):
        counter += 1
    return f"{base}_{counter}{extension}", False


def recover_queued_item(item: dict, job: dict) -> None:
    track = dict(item.get("track") or {})
    track_id = item["track_id"]
    catalog_track = MEDIA_CATALOG.get_track(track_id)
    if catalog_track:
        track = {**track, **catalog_track}
    if not track.get("iphone_path"):
        raise ValueError("The queued track no longer has an iPhone source path.")

    expected_size = int(track.get("size_bytes", item.get("expected_bytes", 0)) or 0)
    primary_path = item.get("primary_path")
    file_hash = item.get("sha256")
    if not (
        primary_path
        and file_hash
        and os.path.isfile(primary_path)
        and os.path.getsize(primary_path) == expected_size
        and sha256_file(primary_path) == file_hash
    ):
        ensure_connected()
        output_dir = normalize_output_directory(job["output_dir"])
        os.makedirs(output_dir, exist_ok=True)
        partial_dir = os.path.join(output_dir, RECOVERY_PARTIAL_DIRNAME)
        os.makedirs(partial_dir, exist_ok=True)
        extension = os.path.splitext(str(track.get("original_filename") or track["iphone_path"]))[1] or ".audio"
        stage_path = os.path.join(partial_dir, f"{item['id']}{extension}")
        copy_afc_file(track["iphone_path"], stage_path, expected_size)

        embedded = parse_audio_metadata(stage_path, track.get("original_filename", ""))
        if track.get("decoded"):
            # The media database is the authoritative mapping for Apple's hashed files.
            embedded.update({
                key: track[key]
                for key in ("title", "artist", "album", "album_artist", "clean_filename")
                if track.get(key)
            })
        updated_track = {**track, **embedded, "metadata_pending": False}
        clean_name = safe_component(
            str(embedded.get("clean_filename") or track.get("clean_filename") or f"beat_{track_id}{extension}"),
            f"beat_{track_id}{extension}",
        )
        target_folder = _queue_target_folder(output_dir, job["structure_mode"], updated_track)
        os.makedirs(target_folder, exist_ok=True)
        file_hash = sha256_file(stage_path)
        primary_path, already_present = _unused_or_matching_path(os.path.join(target_folder, clean_name), file_hash)
        if already_present:
            os.remove(stage_path)
        else:
            os.replace(stage_path, primary_path)
        RECOVERY_QUEUE.update_item(
            item["id"], primary_path=primary_path, sha256=file_hash, bytes=os.path.getsize(primary_path),
            title=updated_track.get("title"),
        )
        MEDIA_CATALOG.upsert_tracks([updated_track])
        with TRACK_REGISTRY_LOCK:
            TRACK_REGISTRY[track_id] = updated_track

    backup_path = item.get("backup_path")
    backup_dir = job.get("backup_dir")
    if backup_dir:
        backup_dir = normalize_output_directory(backup_dir)
        relative = os.path.relpath(primary_path, job["output_dir"])
        if relative.startswith(".."):
            relative = os.path.basename(primary_path)
        backup_candidate = os.path.join(backup_dir, relative)
        if not (
            backup_path and os.path.isfile(backup_path) and sha256_file(backup_path) == file_hash
        ):
            os.makedirs(os.path.dirname(backup_candidate), exist_ok=True)
            backup_path, already_present = _unused_or_matching_path(backup_candidate, file_hash)
            if not already_present:
                partial_backup = backup_path + ".part"
                shutil.copy2(primary_path, partial_backup)
                if sha256_file(partial_backup) != file_hash:
                    raise IOError("The backup copy failed SHA-256 verification.")
                os.replace(partial_backup, backup_path)
        RECOVERY_QUEUE.update_item(item["id"], backup_path=backup_path)

    RECOVERY_QUEUE.update_item(
        item["id"], status="complete", primary_path=primary_path, backup_path=backup_path,
        sha256=file_hash, bytes=os.path.getsize(primary_path), error=None,
    )


def recovery_worker() -> None:
    global RECOVERY_WORKER_THREAD
    try:
        while True:
            item = RECOVERY_QUEUE.claim_next()
            if item is None:
                break
            job = RECOVERY_QUEUE.get_job(item["job_id"])
            if not job:
                RECOVERY_QUEUE.update_item(item["id"], status="failed", error="Recovery job was not found.")
                continue
            if job["status"] == "paused":
                RECOVERY_QUEUE.update_item(item["id"], status="interrupted", error="Paused by user.")
                continue
            try:
                recover_queued_item(item, job)
            except Exception as exc:
                connected = False
                try:
                    connected = bridge.probe()
                except Exception:
                    pass
                state = "failed" if connected else "interrupted"
                RECOVERY_QUEUE.update_item(item["id"], status=state, error=str(exc)[:1000])
                if not connected:
                    RECOVERY_QUEUE.pause_job(item["job_id"])

            for finished_id in RECOVERY_QUEUE.finish_ready_jobs():
                finished = RECOVERY_QUEUE.get_job(finished_id)
                if finished:
                    report_dir = finished["output_dir"] if os.path.isdir(finished["output_dir"]) else os.path.join(DATA_DIR, "reports")
                    try:
                        report = write_recovery_report(finished, report_dir)
                        RECOVERY_QUEUE.save_report(finished_id, report)
                    except OSError:
                        pass
    finally:
        with RECOVERY_WORKER_LOCK:
            RECOVERY_WORKER_THREAD = None


def ensure_recovery_worker() -> None:
    global RECOVERY_WORKER_THREAD
    with RECOVERY_WORKER_LOCK:
        if RECOVERY_WORKER_THREAD and RECOVERY_WORKER_THREAD.is_alive():
            return
        RECOVERY_WORKER_THREAD = threading.Thread(target=recovery_worker, name="idrivepulse-recovery", daemon=True)
        RECOVERY_WORKER_THREAD.start()
