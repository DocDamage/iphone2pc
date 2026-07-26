"""Music scanning, catalog, streaming, and storage API routes."""

from fastapi import APIRouter
from app_core import *
from app_device import *
from app_media_service import *
from app_afc_transfer import copy_afc_file, get_registered_track

router = APIRouter()

@router.get("/api/music/scan")
def scan_music(custom_path: Optional[str] = None):
    """Scan all AFC-accessible storage for audio without downloading the library."""
    ensure_connected()
    with TRACK_REGISTRY_LOCK:
        TRACK_REGISTRY.clear()
    tracks = [data for event, data in iter_audio_scan(custom_path) if event == "track_found"]
    return {"count": len(tracks), "tracks": tracks}


@router.post("/api/library/decode")
async def decode_phone_library():
    """Decode Apple's hashed music paths into a durable, searchable catalog."""
    try:
        snapshot_path, source_path, copied_files = await asyncio.to_thread(snapshot_media_library)
        tracks = await asyncio.to_thread(decode_media_library, snapshot_path)
        await asyncio.to_thread(MEDIA_CATALOG.upsert_tracks, tracks)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except (OSError, sqlite3.DatabaseError, RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=f"Could not decode the iPhone music library: {exc}")

    with TRACK_REGISTRY_LOCK:
        active_paths = {track.get("iphone_path") for track in TRACK_REGISTRY.values()}
        for track in tracks:
            if not active_paths or track["iphone_path"] in active_paths:
                existing = TRACK_REGISTRY.get(track["id"], {})
                TRACK_REGISTRY[track["id"]] = {**existing, **track}
        active_matches = len(active_paths.intersection(track["iphone_path"] for track in tracks))

    return {
        "success": True,
        "decoded_count": len(tracks),
        "active_scan_matches": active_matches,
        "playlist_count": len({name for track in tracks for name in track.get("playlists", [])}),
        "database_files_copied": copied_files,
        "source": source_path,
        "catalog_path": MEDIA_CATALOG.database_path,
    }


@router.get("/api/library/tracks")
def query_library_tracks(
    search: Optional[str] = None,
    extension: Optional[str] = None,
    mystery_only: bool = False,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    min_duration: Optional[float] = None,
    max_duration: Optional[float] = None,
):
    tracks = MEDIA_CATALOG.query_tracks(
        search=search,
        extension=extension,
        mystery_only=mystery_only,
        date_from=date_from,
        date_to=date_to,
        min_duration=min_duration,
        max_duration=max_duration,
    )
    return {"count": len(tracks), "tracks": tracks}


@router.get("/api/library/version-groups")
def library_version_groups():
    groups = MEDIA_CATALOG.version_groups()
    return {"count": len(groups), "groups": groups}


@router.get("/api/music/scan-stream")
async def scan_music_stream(custom_path: Optional[str] = None):
    """Stream lightweight directory-scan results; audio transfers happen on demand."""

    async def event_generator():
        try:
            await asyncio.to_thread(ensure_connected)
        except HTTPException as exc:
            yield {"event": "scan_error", "data": json.dumps({"message": exc.detail})}
            return

        with TRACK_REGISTRY_LOCK:
            TRACK_REGISTRY.clear()

        # AFC calls are blocking through the compatibility adapter. Iterating from a
        # worker one event at a time keeps FastAPI responsive during a deep scan.
        iterator = iter_audio_scan(custom_path)
        while True:
            item = await asyncio.to_thread(next_scan_event, iterator)
            if item is None:
                break
            event, data = item
            yield {"event": event, "data": json.dumps(data)}

    return EventSourceResponse(event_generator())


def cache_track(track: dict) -> tuple[str, dict]:
    track_id = track["id"]
    ext = os.path.splitext(track.get("original_filename", ""))[1].lower()
    if ext not in AUDIO_EXTENSIONS:
        ext = ".audio"
    cache_path = os.path.join(TEMP_CACHE_DIR, f"track_{track_id}{ext}")
    with TRACK_REGISTRY_LOCK:
        lock = TRACK_CACHE_LOCKS.setdefault(track_id, threading.Lock())

    with lock:
        expected_size = int(track.get("size_bytes", 0) or 0)
        if not os.path.exists(cache_path) or os.path.getsize(cache_path) != expected_size:
            copy_afc_file(track["iphone_path"], cache_path, expected_size)
        metadata = parse_audio_metadata(cache_path, track.get("original_filename", ""))
        updated = {**track, **metadata, "metadata_pending": False}
        with TRACK_REGISTRY_LOCK:
            TRACK_REGISTRY[track_id] = updated
        return cache_path, updated


@router.get("/api/music/stream/{track_id}")
def stream_music(track_id: str):
    """Download and cache only the track the user chose to preview."""
    track = get_registered_track(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track is no longer in the active scan. Scan the iPhone again.")

    try:
        file_path, _ = cache_track(track)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not read this track from the iPhone: {exc}")

    # Determine correct MIME type
    ext = os.path.splitext(track.get("original_filename", file_path))[1].lower()
    mime_map = {
        '.mp3': 'audio/mpeg',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
        '.wav': 'audio/wav',
        '.flac': 'audio/flac',
        '.aiff': 'audio/aiff',
        '.caf': 'audio/x-caf',
        '.m4r': 'audio/mp4',
    }
    media_type = mime_map.get(ext, mimetypes.guess_type(file_path)[0] or 'application/octet-stream')

    return FileResponse(file_path, media_type=media_type)


@router.post("/api/open-folder")
async def open_pc_folder(request: Request):
    """Opens specified folder on PC in Windows File Explorer."""
    data = await request.json()
    folder_path = data.get("path") or default_export_directory()
    if not isinstance(folder_path, str):
        raise HTTPException(status_code=400, detail="Folder path must be text.")

    os.makedirs(folder_path, exist_ok=True)
    try:
        if sys.platform == "win32":
            os.startfile(folder_path)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", folder_path])
        else:
            subprocess.Popen(["xdg-open", folder_path])
        return {"success": True, "message": f"Opened folder {folder_path}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to open folder: {e}")


@router.get("/api/device/storage")
def get_device_storage():
    """Returns total, free, and used space on connected iPhone storage."""
    if not bridge.connected or not bridge.afc:
        return {"total_gb": 0, "free_gb": 0, "used_gb": 0, "used_percent": 0}

    try:
        stat = bridge.afc.get_device_info()
        total_bytes = int(stat.get("FSTotalBytes", 0))
        free_bytes = int(stat.get("FSFreeBytes", 0))

        if total_bytes > 0:
            total_gb = round(total_bytes / (1024 ** 3), 1)
            free_gb = round(free_bytes / (1024 ** 3), 1)
            used_gb = round((total_bytes - free_bytes) / (1024 ** 3), 1)
            used_percent = round((used_gb / total_gb) * 100, 1)
        else:
            total_gb, free_gb, used_gb, used_percent = 64.0, 32.0, 32.0, 50.0

        return {
            "total_gb": total_gb,
            "free_gb": free_gb,
            "used_gb": used_gb,
            "used_percent": used_percent
        }
    except Exception:
        return {"total_gb": 0, "free_gb": 0, "used_gb": 0, "used_percent": 0}
