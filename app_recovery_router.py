"""Recovery queue, vault, analysis, and project-analysis routes."""

from fastapi import APIRouter
from app_core import *
from app_device import *
from app_media_service import *
from app_transfer_router import *
from app_recovery_worker import *

router = APIRouter()

@router.post("/api/recovery/jobs")
async def create_recovery_job(request: Request):
    data = await request.json()
    track_ids = data.get("track_ids")
    if not isinstance(track_ids, list) or not track_ids or len(track_ids) > 10000:
        raise HTTPException(status_code=400, detail="Select between 1 and 10,000 catalog tracks.")
    tracks = [get_registered_track(str(track_id)) for track_id in dict.fromkeys(track_ids)]
    missing = [track_id for track_id, track in zip(dict.fromkeys(track_ids), tracks) if not track]
    if missing:
        raise HTTPException(status_code=404, detail=f"{len(missing)} selected tracks are no longer in the catalog.")
    try:
        output_dir = normalize_output_directory(data.get("output_dir") or default_export_directory())
        backup_dir = normalize_output_directory(data["backup_dir"]) if data.get("backup_dir") else None
        if backup_dir and os.path.normcase(output_dir) == os.path.normcase(backup_dir):
            raise ValueError("The primary and backup destinations must be different folders.")
        preflight = calculate_export_preflight(track_ids, output_dir)
        if not preflight["can_export"]:
            raise OSError("The primary destination does not have enough free space.")
        if backup_dir:
            backup_usage = shutil.disk_usage(existing_path_for_disk_usage(backup_dir))
            if backup_usage.free < preflight["selected_bytes"] + preflight["reserve_bytes"]:
                raise OSError("The backup destination does not have enough free space.")
        job_id = RECOVERY_QUEUE.create_job(
            tracks, output_dir, backup_dir=backup_dir, structure_mode=data.get("structure", "flat")
        )
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    ensure_recovery_worker()
    return {"success": True, "job": RECOVERY_QUEUE.get_job(job_id), "preflight": preflight}


@router.get("/api/recovery/jobs")
def list_recovery_jobs():
    jobs = RECOVERY_QUEUE.list_jobs()
    return {"count": len(jobs), "jobs": jobs}


@router.get("/api/recovery/jobs/{job_id}")
def get_recovery_job(job_id: str):
    job = RECOVERY_QUEUE.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Recovery job not found.")
    return job


@router.post("/api/recovery/jobs/{job_id}/pause")
def pause_recovery_job(job_id: str):
    if not RECOVERY_QUEUE.get_job(job_id):
        raise HTTPException(status_code=404, detail="Recovery job not found.")
    RECOVERY_QUEUE.pause_job(job_id)
    return RECOVERY_QUEUE.get_job(job_id)


@router.post("/api/recovery/jobs/{job_id}/resume")
def resume_recovery_job(job_id: str):
    if not RECOVERY_QUEUE.get_job(job_id):
        raise HTTPException(status_code=404, detail="Recovery job not found.")
    RECOVERY_QUEUE.resume_job(job_id)
    ensure_recovery_worker()
    return RECOVERY_QUEUE.get_job(job_id)


@router.post("/api/recovery/jobs/{job_id}/retry")
def retry_recovery_job(job_id: str):
    if not RECOVERY_QUEUE.get_job(job_id):
        raise HTTPException(status_code=404, detail="Recovery job not found.")
    retried = RECOVERY_QUEUE.retry_failed(job_id)
    ensure_recovery_worker()
    return {"retried": retried, "job": RECOVERY_QUEUE.get_job(job_id)}


@router.post("/api/recovery/jobs/{job_id}/reorder")
async def reorder_recovery_job(job_id: str, request: Request):
    data = await request.json()
    track_ids = data.get("track_ids")
    if not isinstance(track_ids, list):
        raise HTTPException(status_code=400, detail="track_ids must be an ordered list.")
    if not RECOVERY_QUEUE.get_job(job_id):
        raise HTTPException(status_code=404, detail="Recovery job not found.")
    RECOVERY_QUEUE.reorder(job_id, [str(track_id) for track_id in track_ids])
    return RECOVERY_QUEUE.get_job(job_id)


@router.post("/api/vault/create")
async def create_rescue_vault(request: Request):
    data = await request.json()
    job = RECOVERY_QUEUE.get_job(str(data.get("job_id") or ""))
    if not job:
        raise HTTPException(status_code=404, detail="Recovery job not found.")
    paths = [item["primary_path"] for item in job["items"] if item.get("status") == "complete" and item.get("primary_path")]
    if not paths:
        raise HTTPException(status_code=400, detail="This job has no completed files to protect.")
    vault_path = data.get("vault_path") or os.path.join(job["output_dir"], f"{job['id']}.idrivevault")
    try:
        return await asyncio.to_thread(encrypt_to_vault, paths, vault_path, data.get("passphrase", ""))
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/api/vault/restore")
async def restore_rescue_vault(request: Request):
    data = await request.json()
    try:
        return await asyncio.to_thread(
            decrypt_vault, data.get("vault_path", ""), data.get("output_dir", ""), data.get("passphrase", "")
        )
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def recovered_path_for_track(track_id: str) -> Optional[str]:
    for job in RECOVERY_QUEUE.list_jobs(limit=500):
        for item in job["items"]:
            if item["track_id"] == track_id and item.get("status") == "complete":
                candidate = item.get("primary_path")
                if candidate and os.path.isfile(candidate):
                    return candidate
    return None


@router.post("/api/analysis/tracks")
async def analyze_selected_tracks(request: Request):
    data = await request.json()
    track_ids = data.get("track_ids")
    if not isinstance(track_ids, list) or not track_ids or len(track_ids) > 200:
        raise HTTPException(status_code=400, detail="Select between 1 and 200 tracks to analyze.")
    results, failed = [], []
    for track_id in dict.fromkeys(str(value) for value in track_ids):
        track = get_registered_track(track_id)
        if not track:
            failed.append({"id": track_id, "reason": "Track is not in the catalog."})
            continue
        try:
            local_path = await asyncio.to_thread(recovered_path_for_track, track_id)
            if not local_path:
                local_path, _updated = await asyncio.to_thread(cache_track, track)
            analysis = await asyncio.to_thread(analyze_audio, local_path)
            await asyncio.to_thread(MEDIA_CATALOG.save_analysis, track_id, analysis)
            results.append({"id": track_id, "title": track.get("title"), "analysis": analysis})
        except Exception as exc:
            failed.append({"id": track_id, "title": track.get("title"), "reason": str(exc)[:1000]})
    return {
        "success": bool(results),
        "analyzed_count": len(results),
        "failed_count": len(failed),
        "results": results,
        "failed": failed,
        "version_groups": MEDIA_CATALOG.version_groups(),
    }


@router.get("/api/analysis/tracks/{track_id}")
def get_track_analysis(track_id: str):
    analysis = MEDIA_CATALOG.get_analysis(track_id)
    if not analysis:
        raise HTTPException(status_code=404, detail="This track has not been analyzed yet.")
    return {"track": MEDIA_CATALOG.get_track(track_id), "analysis": analysis}
