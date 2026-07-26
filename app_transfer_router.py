"""Verified, resumable music export services and API routes."""

from fastapi import APIRouter
from app_core import *
from app_device import *
from app_media_service import *
from app_afc_transfer import copy_afc_file, get_registered_track
from app_media_router import cache_track

router = APIRouter()

def recovery_key(track: dict) -> str:
    identity = f"{normalize_afc_path(track['iphone_path'])}\0{int(track.get('size_bytes', 0) or 0)}"
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        while chunk := source.read(TRANSFER_CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


class RecoveryJournal:
    """Atomic, local record of completed and resumable recovery work."""

    def __init__(self, output_dir: str):
        self.path = os.path.join(output_dir, RECOVERY_JOURNAL_FILENAME)
        self.data = {"version": 1, "entries": {}}
        try:
            with open(self.path, "r", encoding="utf-8") as source:
                loaded = json.load(source)
            if loaded.get("version") == 1 and isinstance(loaded.get("entries"), dict):
                self.data = loaded
        except (FileNotFoundError, OSError, ValueError, TypeError):
            pass

    def get(self, key: str) -> dict:
        entry = self.data["entries"].get(key, {})
        return dict(entry) if isinstance(entry, dict) else {}

    def update(self, key: str, **values):
        entry = {**self.get(key), **values, "updated_at": datetime.now().astimezone().isoformat()}
        self.data["entries"][key] = entry
        self.data["updated_at"] = entry["updated_at"]
        handle, temporary = tempfile.mkstemp(prefix=".idrivepulse-journal-", suffix=".tmp", dir=os.path.dirname(self.path))
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as output:
                json.dump(self.data, output, indent=2, sort_keys=True)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
        except Exception:
            try:
                os.remove(temporary)
            except FileNotFoundError:
                pass
            raise


def normalize_output_directory(output_dir: str) -> str:
    if not isinstance(output_dir, str):
        raise ValueError("Save folder must be text.")
    expanded = os.path.abspath(os.path.expandvars(os.path.expanduser(output_dir.strip())))
    if not output_dir.strip():
        raise ValueError("Choose a save folder.")
    return expanded


def existing_path_for_disk_usage(path: str) -> str:
    candidate = os.path.abspath(path)
    while not os.path.exists(candidate):
        parent = os.path.dirname(candidate)
        if parent == candidate:
            raise ValueError(f"No existing parent is available for {path}.")
        candidate = parent
    return candidate


def calculate_export_preflight(track_ids: list, output_dir: str) -> dict:
    output_dir = normalize_output_directory(output_dir)
    tracks = []
    missing = []
    for track_id in dict.fromkeys(str(value) for value in track_ids):
        track = get_registered_track(track_id)
        if track:
            tracks.append(track)
        else:
            missing.append(track_id)

    selected_bytes = sum(int(track.get("size_bytes", 0) or 0) for track in tracks)
    completed_bytes = 0
    partial_bytes = 0
    journal = RecoveryJournal(output_dir) if os.path.isdir(output_dir) else None
    partial_dir = os.path.join(output_dir, RECOVERY_PARTIAL_DIRNAME)
    for track in tracks:
        expected_size = int(track.get("size_bytes", 0) or 0)
        key = recovery_key(track)
        entry = journal.get(key) if journal else {}
        destination = entry.get("destination")
        if entry.get("status") == "complete" and isinstance(destination, str) and os.path.isfile(destination):
            if os.path.getsize(destination) == expected_size:
                completed_bytes += expected_size
                continue
        stage_path = os.path.join(partial_dir, f"{key}.transfer")
        for candidate in (stage_path, f"{stage_path}.part"):
            if os.path.isfile(candidate):
                partial_bytes += min(expected_size, os.path.getsize(candidate))
                break

    bytes_to_copy = max(0, selected_bytes - completed_bytes - partial_bytes)
    reserve_bytes = max(DISK_RESERVE_MIN_BYTES, int(bytes_to_copy * 0.05))
    usage = shutil.disk_usage(existing_path_for_disk_usage(output_dir))
    required_bytes = bytes_to_copy + reserve_bytes
    return {
        "output_directory": output_dir,
        "selected_count": len(tracks),
        "missing_track_ids": missing,
        "selected_bytes": selected_bytes,
        "selected_size": format_size(selected_bytes),
        "completed_bytes": completed_bytes,
        "resumable_partial_bytes": partial_bytes,
        "bytes_to_copy": bytes_to_copy,
        "required_bytes_with_reserve": required_bytes,
        "free_bytes": usage.free,
        "free_size": format_size(usage.free),
        "reserve_bytes": reserve_bytes,
        "can_export": not missing and usage.free >= required_bytes,
    }


@router.post("/api/music/preflight")
async def export_preflight(request: Request):
    data = await request.json()
    track_ids = data.get("track_ids", [])
    if not isinstance(track_ids, list) or not track_ids or len(track_ids) > 10000:
        raise HTTPException(status_code=400, detail="Select between 1 and 10,000 scanned tracks.")
    try:
        return calculate_export_preflight(track_ids, data.get("output_dir") or default_export_directory())
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"Cannot inspect the selected save folder: {exc}")


@router.post("/api/music/export")
async def export_music(request: Request):
    """Export selected tracks with disk preflight, resume, and a recovery journal."""
    data = await request.json()
    track_ids = data.get("track_ids") or [item.get("id") for item in data.get("tracks", []) if isinstance(item, dict)]
    output_dir = data.get("output_dir") or default_export_directory()
    if not isinstance(track_ids, list) or len(track_ids) > 10000:
        raise HTTPException(status_code=400, detail="track_ids must be a list of at most 10,000 tracks.")
    try:
        output_dir = normalize_output_directory(output_dir)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    structure_mode = data.get("structure", "flat")  # "flat", "artist", "album"
    if structure_mode not in {"flat", "artist", "album"}:
        raise HTTPException(status_code=400, detail="Invalid export folder structure.")
    if not track_ids:
        raise HTTPException(status_code=400, detail="No tracks were selected.")

    try:
        preflight = calculate_export_preflight(track_ids, output_dir)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"Cannot inspect the selected save folder: {exc}")
    if preflight["free_bytes"] < preflight["required_bytes_with_reserve"]:
        raise HTTPException(
            status_code=507,
            detail=(
                f"Not enough free space. This selection needs {format_size(preflight['required_bytes_with_reserve'])} "
                f"including the safety reserve, but the destination has {preflight['free_size']} free."
            ),
        )

    try:
        os.makedirs(output_dir, exist_ok=True)
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Cannot use the selected save folder: {exc}")

    exported = []
    failed = []
    partial_dir = os.path.join(output_dir, RECOVERY_PARTIAL_DIRNAME)
    os.makedirs(partial_dir, exist_ok=True)
    journal = RecoveryJournal(output_dir)

    for track_id in dict.fromkeys(track_ids):
        tr = get_registered_track(str(track_id))
        if not tr:
            failed.append({"id": track_id, "title": "Unknown track", "reason": "Track is not in the active scan"})
            continue

        key = recovery_key(tr)
        stage_path = os.path.join(partial_dir, f"{key}.transfer")
        expected_size = int(tr.get("size_bytes", 0) or 0)
        entry = journal.get(key)
        resumed_bytes = os.path.getsize(f"{stage_path}.part") if os.path.isfile(f"{stage_path}.part") else 0
        try:
            completed_path = entry.get("destination")
            completed_hash = entry.get("sha256")
            if (
                entry.get("status") == "complete"
                and isinstance(completed_path, str)
                and os.path.isfile(completed_path)
                and os.path.getsize(completed_path) == expected_size
                and isinstance(completed_hash, str)
                and sha256_file(completed_path) == completed_hash
            ):
                exported.append({
                    "id": tr["id"],
                    "title": entry.get("title") or tr.get("title"),
                    "destination": completed_path,
                    "bytes": expected_size,
                    "source": tr["iphone_path"],
                    "verified_existing": True,
                })
                continue

            journal.update(
                key,
                status="transferring",
                source=tr["iphone_path"],
                expected_bytes=expected_size,
                partial_path=f"{stage_path}.part",
            )
            await asyncio.to_thread(
                copy_afc_file,
                tr["iphone_path"],
                stage_path,
                expected_size,
            )

            # Read tags only after the file is safely on the PC. The original bytes are
            # never edited; metadata is used solely to choose a human-friendly filename.
            metadata = parse_audio_metadata(stage_path, tr.get("original_filename", ""))
            updated_track = {**tr, **metadata, "metadata_pending": False}
            clean_name = metadata.get("clean_filename") or tr.get("clean_filename") or f"beat_{tr['id']}.audio"
            clean_name = safe_component(clean_name, f"beat_{tr['id']}.audio")

            # Subfolder structuring
            target_folder = output_dir
            if structure_mode == "artist":
                target_folder = os.path.join(output_dir, safe_component(str(metadata.get("artist", "")), "Unknown Artist"))
            elif structure_mode == "album":
                target_folder = os.path.join(output_dir, safe_component(str(metadata.get("album", "")), "Unknown Album"))

            os.makedirs(target_folder, exist_ok=True)
            target_path = os.path.join(target_folder, clean_name)

            # Handle duplicate filenames
            counter = 1
            base, ext = os.path.splitext(target_path)
            while os.path.exists(target_path):
                target_path = f"{base}_{counter}{ext}"
                counter += 1

            file_hash = await asyncio.to_thread(sha256_file, stage_path)
            journal.update(
                key,
                status="finalizing",
                destination=target_path,
                sha256=file_hash,
                title=metadata.get("title") or tr.get("title"),
            )
            os.replace(stage_path, target_path)
            journal.update(key, status="complete", destination=target_path, sha256=file_hash)
            with TRACK_REGISTRY_LOCK:
                TRACK_REGISTRY[tr["id"]] = updated_track
            exported.append({
                "id": tr["id"],
                "title": metadata.get("title") or tr.get("title"),
                "destination": target_path,
                "bytes": os.path.getsize(target_path),
                "source": tr["iphone_path"],
                "sha256": file_hash,
                "resumed_bytes": resumed_bytes,
            })
        except Exception as e:
            try:
                journal.update(key, status="interrupted", error=str(e)[:500])
            except OSError:
                pass
            failed.append({"id": tr.get("id"), "title": tr.get("title"), "reason": str(e)})

    return {
        "success": len(exported) > 0,
        "complete": not failed,
        "exported_count": len(exported),
        "failed_count": len(failed),
        "output_directory": output_dir,
        "exported": exported,
        "failed": failed,
        "preflight": preflight,
        "journal": journal.path,
    }
