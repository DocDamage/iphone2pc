"""Project-bundle discovery and recovery routes."""

from fastapi import APIRouter
from app_core import *
from app_device import *
from app_media_service import *
from app_transfer_router import *

router = APIRouter()

PROJECT_EXTENSIONS = frozenset({
    ".als", ".alp", ".flp", ".logicx", ".band", ".ptx", ".ptf", ".rpp",
    ".song", ".cpr", ".npr", ".mid", ".midi", ".zip", ".rar", ".7z",
    ".wav", ".aif", ".aiff", ".flac", ".mp3", ".m4a", ".caf",
})


def project_bundle_candidates(track: dict) -> list[dict]:
    ensure_connected()
    source = normalize_afc_path(track["iphone_path"])
    parent = posixpath.dirname(source) or "/"
    source_stem = posixpath.splitext(posixpath.basename(source))[0].casefold()
    results = []
    for name in bridge.afc.listdir(parent):
        if name in {".", ".."}:
            continue
        path = normalize_afc_path(posixpath.join(parent, name))
        try:
            stat = bridge.afc.stat(path)
        except Exception:
            continue
        is_dir = is_afc_directory(stat)
        item_stem, extension = posixpath.splitext(name)
        related_name = (
            path == source
            or item_stem.casefold() == source_stem
            or item_stem.casefold().startswith(tuple(source_stem + separator for separator in ("_", " - ", " ")))
        )
        if path == source or (is_dir and related_name) or (extension.lower() in PROJECT_EXTENSIONS and related_name):
            results.append({
                "name": name, "path": path, "is_dir": bool(is_dir),
                "size_bytes": int(stat.get("st_size", 0) or 0), "extension": extension.lower(),
            })
    results.sort(key=lambda value: (value["path"] != source, not value["is_dir"], value["name"].casefold()))
    return results


@router.get("/api/projects/bundle/{track_id}")
def preview_project_bundle(track_id: str):
    track = get_registered_track(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track is not in the catalog.")
    candidates = project_bundle_candidates(track)
    return {"track": track, "count": len(candidates), "candidates": candidates}


def iter_afc_bundle_files(root_path: str):
    stat = bridge.afc.stat(root_path)
    if not is_afc_directory(stat):
        yield root_path, stat
        return
    pending = [root_path]
    while pending:
        directory = pending.pop(0)
        for name in bridge.afc.listdir(directory):
            if name in {".", ".."}:
                continue
            path = normalize_afc_path(posixpath.join(directory, name))
            child_stat = bridge.afc.stat(path)
            if is_afc_directory(child_stat):
                pending.append(path)
            else:
                yield path, child_stat


@router.post("/api/projects/bundle/{track_id}/recover")
async def recover_project_bundle(track_id: str, request: Request):
    track = get_registered_track(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track is not in the catalog.")
    data = await request.json()
    selected = data.get("paths")
    if not isinstance(selected, list) or not selected:
        raise HTTPException(status_code=400, detail="Choose at least one project-bundle item.")
    allowed = {item["path"] for item in await asyncio.to_thread(project_bundle_candidates, track)}
    selected_paths = [normalize_afc_path(path) for path in selected if normalize_afc_path(path) in allowed]
    if not selected_paths:
        raise HTTPException(status_code=400, detail="No selected paths belong to this project bundle.")
    try:
        output_dir = normalize_output_directory(data.get("output_dir") or default_export_directory())
        bundle_dir = os.path.join(output_dir, safe_component(str(track.get("title") or "Recovered Project"), "Recovered Project") + " - Project Files")
        os.makedirs(bundle_dir, exist_ok=True)
        recovered = []
        parent = posixpath.dirname(track["iphone_path"])
        for selected_path in selected_paths:
            for remote_path, stat in await asyncio.to_thread(lambda p=selected_path: list(iter_afc_bundle_files(p))):
                relative = posixpath.relpath(remote_path, parent).replace("/", os.sep)
                destination = os.path.abspath(os.path.join(bundle_dir, relative))
                if os.path.commonpath([bundle_dir, destination]) != os.path.abspath(bundle_dir):
                    raise ValueError("Unsafe project path.")
                await asyncio.to_thread(copy_afc_file, remote_path, destination, int(stat.get("st_size", 0) or 0))
                recovered.append({"source": remote_path, "destination": destination, "sha256": await asyncio.to_thread(sha256_file, destination)})
        return {"success": True, "output_directory": bundle_dir, "count": len(recovered), "files": recovered}
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
