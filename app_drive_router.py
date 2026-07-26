"""Read-only AFC explorer and Portable Files mutation routes."""

from fastapi import APIRouter
from app_core import *
from app_device import *
from app_media_service import *
from app_afc_transfer import copy_afc_file

router = APIRouter()

@router.get("/api/drive/list")
def list_drive_path(path: str = "/"):
    """Lists files and folders on iPhone like a portable hard drive."""
    if not bridge.connected or not bridge.afc:
        success, _ = bridge.connect(force=True)
        if not success or not bridge.afc:
            raise HTTPException(status_code=400, detail="No iPhone connected. Connect via USB and unlock iPhone.")

    clean_path = normalize_afc_path(path)
    try:
        items = bridge.afc.listdir(clean_path)
        result = []
        for item in items:
            if item in (".", ".."):
                continue
            item_full = f"{clean_path}/{item}".replace("//", "/")
            try:
                info = bridge.afc.stat(item_full)
                is_dir = info.get("st_ifmt") == "S_IFDIR" or info.get("st_mode", 0) & 0o040000
                size = info.get("st_size", 0)
                mtime = info.get("st_mtime", 0)

                result.append({
                    "name": item,
                    "path": item_full,
                    "is_dir": bool(is_dir),
                    "size": size,
                    "size_str": format_size(size) if not is_dir else "--",
                    "mtime": format_device_mtime(mtime),
                })
            except Exception:
                result.append({"name": item, "path": item_full, "is_dir": False, "size": 0, "size_str": "--", "mtime": "--"})

        # Sort folders first, then files alphabetically
        result.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))

        # Determine parent path for "Go Up"
        parent_path = "/" + "/".join(clean_path.strip("/").split("/")[:-1]) if clean_path != "/" else None

        return {
            "current_path": clean_path,
            "parent_path": parent_path,
            "items": result,
            "writable": is_within_afc_path(clean_path, PORTABLE_FILES_ROOT),
            "portable_files_root": PORTABLE_FILES_ROOT,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error reading directory {clean_path}: {e}")


@router.get("/api/drive/download")
def download_drive_file(path: str):
    """Downloads a file from iPhone AFC path without buffering it in RAM."""
    ensure_connected()
    clean_path = normalize_afc_path(path)
    filename = safe_filename(posixpath.basename(clean_path))
    temp_handle, temp_out = tempfile.mkstemp(prefix="download_", suffix=os.path.splitext(filename)[1], dir=TEMP_CACHE_DIR)
    os.close(temp_handle)
    os.remove(temp_out)

    try:
        info = bridge.afc.stat(clean_path)
        if is_afc_directory(info):
            raise HTTPException(status_code=400, detail="Use batch download to save a folder.")
        copy_afc_file(clean_path, temp_out, int(info.get("st_size", 0) or 0))
        return FileResponse(
            temp_out,
            filename=filename,
            media_type="application/octet-stream",
            background=BackgroundTask(os.remove, temp_out),
        )
    except HTTPException:
        raise
    except Exception as e:
        try:
            os.remove(temp_out)
        except FileNotFoundError:
            pass
        raise HTTPException(status_code=500, detail=f"Failed to download file from iPhone: {e}")


@router.post("/api/drive/download-batch")
async def download_batch(request: Request):
    """Downloads multiple files to a temporary ZIP using bounded memory."""
    await asyncio.to_thread(ensure_connected)

    data = await request.json()
    file_paths = data.get("paths", [])
    if not isinstance(file_paths, list) or not file_paths:
        raise HTTPException(status_code=400, detail="No files specified for download.")
    if len(file_paths) > 1000 or not all(isinstance(path, str) for path in file_paths):
        raise HTTPException(status_code=400, detail="Select at most 1,000 valid file paths.")

    temp_handle, zip_path = tempfile.mkstemp(prefix="idrivepulse_export_", suffix=".zip", dir=TEMP_CACHE_DIR)
    os.close(temp_handle)
    failures = []
    try:
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            for fpath in dict.fromkeys(file_paths):
                clean = normalize_afc_path(fpath)
                archive_name = clean.lstrip("/") or "iphone-root"
                handle = None
                try:
                    info = await asyncio.to_thread(bridge.afc.stat, clean)
                    if is_afc_directory(info):
                        failures.append(f"{clean}: folders are not included; select files inside it")
                        continue
                    remaining = int(info.get("st_size", 0) or 0)
                    handle = await asyncio.to_thread(bridge.afc.fopen, clean, "r")
                    with zf.open(archive_name, "w", force_zip64=True) as entry:
                        while remaining > 0:
                            chunk = await asyncio.to_thread(bridge.afc.fread, handle, min(TRANSFER_CHUNK_SIZE, remaining))
                            if not chunk:
                                raise IOError(f"Transfer ended with {remaining} bytes remaining")
                            entry.write(chunk)
                            remaining -= len(chunk)
                except Exception as exc:
                    failures.append(f"{clean}: {exc}")
                finally:
                    if handle is not None:
                        try:
                            await asyncio.to_thread(bridge.afc.fclose, handle)
                        except Exception:
                            pass
            if failures:
                zf.writestr("TRANSFER_ERRORS.txt", "\n".join(failures))
    except Exception:
        try:
            os.remove(zip_path)
        except FileNotFoundError:
            pass
        raise

    timestamp = time.strftime("%Y%m%d_%H%M%S")
    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=f"iDrivePulse_Export_{timestamp}.zip",
        background=BackgroundTask(os.remove, zip_path),
    )


@router.post("/api/drive/upload")
async def upload_drive_file(destination_path: str = Form(...), file: UploadFile = File(...)):
    """Upload only to the dedicated Portable Files folder; never overwrite."""
    await asyncio.to_thread(ensure_connected)
    try:
        clean_dest = require_portable_write_path(destination_path)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    try:
        filename = safe_filename(file.filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    target_afc_file = normalize_afc_path(posixpath.join(clean_dest, filename))

    temp_handle, temp_path = tempfile.mkstemp(prefix="upload_", suffix=os.path.splitext(filename)[1], dir=TEMP_CACHE_DIR)
    os.close(temp_handle)
    try:
        if await asyncio.to_thread(bridge.afc.exists, target_afc_file):
            raise HTTPException(status_code=409, detail=f"{filename} already exists on the iPhone.")
        with open(temp_path, "wb") as output:
            while chunk := await file.read(TRANSFER_CHUNK_SIZE):
                output.write(chunk)
        try:
            await asyncio.to_thread(bridge.afc.push, temp_path, target_afc_file, progress_bar=False)
        except TypeError:
            await asyncio.to_thread(bridge.afc.push, temp_path, target_afc_file)
        return {"success": True, "message": f"Successfully uploaded {filename} to iPhone path {target_afc_file}"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {e}")
    finally:
        try:
            os.remove(temp_path)
        except FileNotFoundError:
            pass


@router.post("/api/drive/mkdir")
async def create_directory(request: Request):
    """Create a directory only inside the dedicated Portable Files folder."""
    if not bridge.connected or not bridge.afc:
        raise HTTPException(status_code=400, detail="iPhone not connected.")

    data = await request.json()
    dir_path = data.get("path", "").strip()
    if not dir_path:
        raise HTTPException(status_code=400, detail="No directory path provided.")

    try:
        clean_path = require_portable_write_path(dir_path, allow_root=False)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc))

    try:
        bridge.afc.makedirs(clean_path)
        return {"success": True, "message": f"Created directory: {clean_path}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create directory: {e}")


@router.delete("/api/drive/delete")
def delete_drive_file(path: str):
    """Delete only within the dedicated Portable Files folder."""
    if not bridge.connected or not bridge.afc:
        raise HTTPException(status_code=400, detail="iPhone not connected.")

    try:
        clean_path = require_portable_write_path(path, allow_root=False)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    try:
        bridge.afc.rm(clean_path)
        return {"success": True, "message": f"Deleted {clean_path}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Delete failed: {e}")


@router.post("/api/drive/portable/setup")
async def setup_portable_files_folder():
    """Create the single AFC folder that the app is allowed to modify."""
    await asyncio.to_thread(ensure_connected)
    try:
        if not await asyncio.to_thread(bridge.afc.exists, PORTABLE_FILES_ROOT):
            await asyncio.to_thread(bridge.afc.makedirs, PORTABLE_FILES_ROOT)
        return {
            "success": True,
            "path": PORTABLE_FILES_ROOT,
            "message": "Portable Files is ready. All other visible iPhone folders remain read-only.",
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not create Portable Files: {exc}")


@router.get("/api/drive/search")
def search_drive(query: str, root: str = "/"):
    """Searches for files matching query across the iPhone AFC filesystem."""
    if not bridge.connected or not bridge.afc:
        raise HTTPException(status_code=400, detail="iPhone not connected.")

    query_lower = query.lower().strip()
    if not query_lower:
        raise HTTPException(status_code=400, detail="Empty search query.")

    results = []
    clean_root = normalize_afc_path(root)
    max_results = 100

    try:
        dirs_to_visit = [clean_root]
        while dirs_to_visit and len(results) < max_results:
            curr_dir = dirs_to_visit.pop(0)
            try:
                items = bridge.afc.listdir(curr_dir)
                for item in items:
                    if item in (".", ".."):
                        continue
                    full_path = f"{curr_dir}/{item}".replace("//", "/")
                    try:
                        info = bridge.afc.stat(full_path)
                        is_dir = info.get("st_ifmt") == "S_IFDIR" or info.get("st_mode", 0) & 0o040000

                        if is_dir:
                            dirs_to_visit.append(full_path)

                        if query_lower in item.lower():
                            size = info.get("st_size", 0)
                            results.append({
                                "name": item,
                                "path": full_path,
                                "is_dir": bool(is_dir),
                                "size": size,
                                "size_str": format_size(size) if not is_dir else "--",
                            })
                    except Exception:
                        continue
            except Exception:
                continue
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search error: {e}")

    return {"query": query, "count": len(results), "results": results}


# =================--- OPTIONAL IOS COMPANION APP DOCUMENTS ---===================
