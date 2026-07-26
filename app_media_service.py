"""Audio inventory, metadata, AFC copy, and media-library services."""

from app_core import *
from app_device import *
from app_afc_transfer import copy_afc_file

def parse_audio_metadata(file_path: str, filename_hint: str = "") -> dict:
    meta = {
        "title": os.path.splitext(os.path.basename(filename_hint or file_path))[0],
        "artist": "Unknown Artist",
        "album": "Unknown Album / Original Beats",
        "duration": 0,
        "duration_str": "0:00",
        "bitrate": 0,
        "filesize": 0,
        "has_artwork": False
    }

    try:
        meta["filesize"] = round(os.path.getsize(file_path) / (1024 * 1024), 2)
    except Exception:
        pass

    if HAS_MUTAGEN:
        try:
            audio = mutagen.File(file_path)
            if audio is not None:
                if hasattr(audio, 'info') and audio.info:
                    meta["duration"] = int(getattr(audio.info, 'length', 0))
                    mins = meta["duration"] // 60
                    secs = meta["duration"] % 60
                    meta["duration_str"] = f"{mins}:{secs:02d}"
                    meta["bitrate"] = getattr(audio.info, 'bitrate', 0) // 1000 if hasattr(audio.info, 'bitrate') else 0

                # Tags extraction
                if isinstance(audio, MP3):
                    if audio.tags:
                        if 'TIT2' in audio.tags: meta["title"] = str(audio.tags['TIT2'])
                        if 'TPE1' in audio.tags: meta["artist"] = str(audio.tags['TPE1'])
                        if 'TALB' in audio.tags: meta["album"] = str(audio.tags['TALB'])
                        for tag in audio.tags.keys():
                            if tag.startswith('APIC'):
                                meta["has_artwork"] = True
                                break
                elif isinstance(audio, MP4):
                    tags = audio.tags
                    if tags:
                        if '\xa9nam' in tags and tags['\xa9nam']: meta["title"] = tags['\xa9nam'][0]
                        if '\xa9ART' in tags and tags['\xa9ART']: meta["artist"] = tags['\xa9ART'][0]
                        if '\xa9alb' in tags and tags['\xa9alb']: meta["album"] = tags['\xa9alb'][0]
                        if 'covr' in tags and tags['covr']: meta["has_artwork"] = True
                elif isinstance(audio, EasyID3):
                    if 'title' in audio: meta["title"] = audio['title'][0]
                    if 'artist' in audio: meta["artist"] = audio['artist'][0]
                    if 'album' in audio: meta["album"] = audio['album'][0]
                elif hasattr(audio, 'tags') and audio.tags:
                    for k, v in audio.tags.items():
                        k_lower = str(k).lower()
                        if 'title' in k_lower and isinstance(v, list) and len(v) > 0:
                            meta["title"] = str(v[0])
                        elif 'artist' in k_lower and isinstance(v, list) and len(v) > 0:
                            meta["artist"] = str(v[0])
                        elif 'album' in k_lower and isinstance(v, list) and len(v) > 0:
                            meta["album"] = str(v[0])
        except Exception as e:
            print(f"Error reading audio metadata for {file_path}: {e}")

    # Format clean filename for PC export
    safe_title = safe_component(str(meta["title"]), "Recovered audio")
    safe_artist = safe_component(str(meta["artist"]), "Unknown Artist")
    ext = os.path.splitext(filename_hint or file_path)[1] or ".mp3"

    if safe_artist and safe_artist.lower() != "unknown artist":
        meta["clean_filename"] = f"{safe_artist} - {safe_title}{ext}"
    else:
        meta["clean_filename"] = f"{safe_title}{ext}"

    return meta


def _track_from_stat(full_path: str, filename: str, info: dict) -> dict:
    size_bytes = int(info.get("st_size", 0) or 0)
    track_id = "tr_" + hashlib.sha256(full_path.encode("utf-8", errors="replace")).hexdigest()[:16]
    display_name = os.path.splitext(filename)[0] or "Recovered audio"
    scanned = {
        "id": track_id,
        "title": display_name,
        "artist": "Metadata loads when transferred",
        "album": "Accessible iPhone storage",
        "duration": 0,
        "duration_str": "--",
        "bitrate": 0,
        "filesize": round(size_bytes / (1024 * 1024), 2),
        "size_bytes": size_bytes,
        "has_artwork": False,
        "clean_filename": safe_component(filename, f"{track_id}.audio"),
        "iphone_path": full_path,
        "original_filename": filename,
        "modified": format_device_mtime(info.get("st_mtime")),
        "metadata_pending": True,
        "extension": os.path.splitext(filename)[1].lower(),
    }
    decoded = MEDIA_CATALOG.get_by_path(full_path)
    if decoded and decoded.get("decoded"):
        # The live stat remains authoritative for size and modification time, while
        # the media database supplies the human metadata Apple hides behind hashes.
        return {
            **scanned,
            **decoded,
            "id": track_id,
            "iphone_path": full_path,
            "original_filename": filename,
            "size_bytes": size_bytes,
            "filesize": round(size_bytes / (1024 * 1024), 2),
            "modified": format_device_mtime(info.get("st_mtime")) or decoded.get("modified"),
            "metadata_pending": False,
            "decoded": True,
        }
    return scanned


def iter_audio_scan(custom_path: Optional[str] = None, device_bridge=None):
    """Yield scan events without copying audio data off the phone."""
    active_bridge = device_bridge or bridge
    requested_roots = ([normalize_afc_path(custom_path)] if custom_path else []) + list(DEFAULT_SCAN_ROOTS)
    search_roots = list(dict.fromkeys(requested_roots))
    visited_dirs = set()
    seen_files = set()
    total_dirs = 0
    total_tracks = 0

    yield "scan_start", {"roots": search_roots}
    for root in search_roots:
        try:
            if not active_bridge.afc.exists(root):
                continue
        except Exception as exc:
            yield "warning", {"message": f"Could not inspect {root}: {exc}"}
            continue

        yield "scanning_root", {"root": root}
        dirs_to_visit = [root]
        while dirs_to_visit:
            curr_dir = dirs_to_visit.pop(0)
            if curr_dir in visited_dirs:
                continue
            visited_dirs.add(curr_dir)
            total_dirs += 1

            try:
                items = active_bridge.afc.listdir(curr_dir)
            except Exception as exc:
                yield "warning", {"message": f"Skipped unreadable folder {curr_dir}: {exc}"}
                continue

            for item in items:
                if item in (".", ".."):
                    continue
                full_path = normalize_afc_path(posixpath.join(curr_dir, item))
                try:
                    info = active_bridge.afc.stat(full_path)
                except Exception:
                    continue

                if is_afc_directory(info):
                    if full_path not in visited_dirs:
                        dirs_to_visit.append(full_path)
                    continue

                if full_path in seen_files or os.path.splitext(item)[1].lower() not in AUDIO_EXTENSIONS:
                    continue

                seen_files.add(full_path)
                track = _track_from_stat(full_path, item, info)
                with TRACK_REGISTRY_LOCK:
                    TRACK_REGISTRY[track["id"]] = track
                MEDIA_CATALOG.upsert_tracks([track])
                total_tracks += 1
                yield "track_found", track

            if total_dirs % 5 == 0:
                yield "progress", {"dirs_scanned": total_dirs, "tracks_found": total_tracks}

    yield "scan_complete", {"total_tracks": total_tracks, "total_dirs": total_dirs}


def next_scan_event(iterator):
    try:
        return next(iterator)
    except StopIteration:
        return None


def ensure_connected():
    if bridge.connected and bridge.afc:
        return
    success, message = bridge.connect(force=True)
    if not success or not bridge.afc:
        raise HTTPException(status_code=400, detail=message or "No iPhone connected over USB.")


MEDIA_LIBRARY_CANDIDATES = (
    "/iTunes_Control/iTunes/MediaLibrary.sqlitedb",
    "/iTunes_Control/iTunes/MediaLibrary.sqlite",
    "/Media/iTunes_Control/iTunes/MediaLibrary.sqlitedb",
)


def locate_media_library() -> str:
    for candidate in MEDIA_LIBRARY_CANDIDATES:
        try:
            if bridge.afc.exists(candidate):
                return candidate
        except Exception:
            continue
    raise FileNotFoundError(
        "The iPhone media-library database is not exposed in the current AFC session. "
        "Keep the phone unlocked, then reconnect and try again."
    )


def snapshot_media_library() -> tuple[str, str, int]:
    """Take a checked, read-only snapshot of Apple's live SQLite library."""
    ensure_connected()
    source = locate_media_library()
    device_key = hashlib.sha256(
        str(bridge.device_info.get("UniqueDeviceID") or "iphone").encode("utf-8", errors="replace")
    ).hexdigest()[:16]
    snapshot_dir = os.path.join(DATA_DIR, "library_snapshots", device_key)
    os.makedirs(snapshot_dir, exist_ok=True)
    destination = os.path.join(snapshot_dir, "MediaLibrary.sqlitedb")
    copied_files = 0
    last_error = "The live database changed during every snapshot attempt."

    for _attempt in range(3):
        available: list[tuple[str, str, int]] = []
        for suffix in ("", "-wal", "-shm"):
            remote_path = source + suffix
            try:
                stat = bridge.afc.stat(remote_path)
                available.append((remote_path, destination + suffix, int(stat.get("st_size", 0) or 0)))
            except Exception:
                if suffix == "":
                    raise FileNotFoundError("The media-library database disappeared during the snapshot.")

        initial_sizes = {remote: size for remote, _local, size in available}
        try:
            for _remote, local, _size in available:
                for candidate in (local, f"{local}.part"):
                    try:
                        os.remove(candidate)
                    except FileNotFoundError:
                        pass
            for remote, local, size in available:
                copy_afc_file(remote, local, size)

            stable = True
            for remote, _local, original_size in available:
                try:
                    stable = stable and int(bridge.afc.stat(remote).get("st_size", 0) or 0) == original_size
                except Exception:
                    stable = False
            if not stable:
                last_error = "The media library changed while it was being copied."
                continue

            check = sqlite3.connect(f"file:{Path(destination).resolve().as_posix()}?mode=ro", uri=True)
            try:
                result = check.execute("PRAGMA quick_check").fetchone()
            finally:
                check.close()
            if result and result[0] == "ok":
                copied_files = len(available)
                return destination, source, copied_files
            last_error = f"SQLite integrity check returned: {result[0] if result else 'no result'}"
        except Exception as exc:
            last_error = str(exc)

    raise RuntimeError(f"Could not create a consistent media-library snapshot: {last_error}")
