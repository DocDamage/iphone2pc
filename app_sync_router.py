"""Portable Files synchronization profile and conflict routes."""

from fastapi import APIRouter
from app_core import *
from app_device import *
from app_media_service import *
from app_sync_service import *

router = APIRouter()

@router.post("/api/sync/profiles")
async def create_portable_sync_profile(request: Request):
    data = await request.json()
    try:
        local_root = normalize_output_directory(data.get("local_root", ""))
        os.makedirs(local_root, exist_ok=True)
        ensure_connected()
        if not bridge.afc.exists(PORTABLE_FILES_ROOT):
            bridge.afc.makedirs(PORTABLE_FILES_ROOT)
        profile_id = PORTABLE_SYNC.create_profile(
            local_root, PORTABLE_FILES_ROOT, enabled=bool(data.get("enabled", False))
        )
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if data.get("enabled"):
        ensure_portable_sync_scheduler()
    return PORTABLE_SYNC.get_profile(profile_id)


@router.get("/api/sync/profiles")
def list_portable_sync_profiles():
    profiles = PORTABLE_SYNC.list_profiles()
    return {"count": len(profiles), "profiles": profiles, "version_root": PORTABLE_SYNC.version_root}


@router.post("/api/sync/profiles/{profile_id}/run")
async def run_portable_sync_now(profile_id: str):
    try:
        return await asyncio.to_thread(run_portable_sync, profile_id)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/api/sync/profiles/{profile_id}/enable")
async def enable_portable_sync(profile_id: str, request: Request):
    if not PORTABLE_SYNC.get_profile(profile_id):
        raise HTTPException(status_code=404, detail="Sync profile not found.")
    data = await request.json()
    enabled = bool(data.get("enabled", True))
    PORTABLE_SYNC.set_enabled(profile_id, enabled)
    if enabled:
        ensure_portable_sync_scheduler()
    return PORTABLE_SYNC.get_profile(profile_id)


@router.get("/api/sync/conflicts")
def list_portable_sync_conflicts(profile_id: Optional[str] = None):
    conflicts = PORTABLE_SYNC.conflicts(profile_id)
    return {"count": len(conflicts), "conflicts": conflicts}


@router.post("/api/sync/conflicts/{conflict_id}/resolve")
async def resolve_sync_conflict_endpoint(conflict_id: str, request: Request):
    data = await request.json()
    try:
        ensure_connected()
        with SYNC_RUN_LOCK:
            return await asyncio.to_thread(
                resolve_portable_conflict,
                PORTABLE_SYNC, conflict_id, data.get("choice", ""), bridge.afc,
                copy_afc_file, portable_sync_upload, portable_sync_remove,
            )
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# =================--- PORTABLE DRIVE / FILE EXPLORER API ---===================
