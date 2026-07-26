"""Sandboxed iOS companion-document routes."""

from fastapi import APIRouter
from app_core import *
from app_device import *
from app_media_service import *
from app_afc_transfer import copy_afc_file

router = APIRouter()

COMPANION_BUNDLE_ID = "com.idrivepulse.companion"
COMPANION_PORTABLE_ROOT = "/Portable Files"


class CompanionServiceBridge:
    def __init__(self, afc):
        self.afc = afc
        self.connected = True

    def connect(self, force=False):
        return True, "Companion Documents connected."


def normalize_companion_path(path: str) -> str:
    normalized = normalize_afc_path(path)
    if normalized == "/":
        return normalized
    if not (normalized == COMPANION_PORTABLE_ROOT or normalized.startswith(COMPANION_PORTABLE_ROOT + "/")):
        raise ValueError("Companion writes are restricted to its Portable Files folder.")
    return normalized


def open_companion_documents():
    ensure_connected()
    if not PYMOBILEDEVICE_ASYNC or not isinstance(bridge.afc, AsyncAFCSession):
        raise RuntimeError("The installed iPhone connector does not support companion app documents.")
    return bridge.afc.open_app_documents(COMPANION_BUNDLE_ID)


@router.get("/api/companion/status")
async def companion_status():
    try:
        documents = await asyncio.to_thread(open_companion_documents)
        try:
            if not await asyncio.to_thread(documents.exists, COMPANION_PORTABLE_ROOT):
                await asyncio.to_thread(documents.makedirs, COMPANION_PORTABLE_ROOT)
            entries = await asyncio.to_thread(documents.listdir, COMPANION_PORTABLE_ROOT)
            return {
                "installed": True, "bundle_id": COMPANION_BUNDLE_ID,
                "portable_root": COMPANION_PORTABLE_ROOT,
                "item_count": len([name for name in entries if name not in {".", ".."}]),
            }
        finally:
            await asyncio.to_thread(documents.close)
    except Exception as exc:
        return {
            "installed": False, "bundle_id": COMPANION_BUNDLE_ID,
            "message": f"Install and open the iDrivePulse Companion on the iPhone first: {exc}",
        }


@router.get("/api/companion/list")
async def list_companion_files(path: str = COMPANION_PORTABLE_ROOT):
    try:
        clean_path = normalize_companion_path(path)
        documents = await asyncio.to_thread(open_companion_documents)
        try:
            items = []
            for name in await asyncio.to_thread(documents.listdir, clean_path):
                if name in {".", ".."}:
                    continue
                item_path = normalize_afc_path(posixpath.join(clean_path, name))
                stat = await asyncio.to_thread(documents.stat, item_path)
                directory = is_afc_directory(stat)
                items.append({
                    "name": name, "path": item_path, "is_dir": directory,
                    "size_bytes": int(stat.get("st_size", 0) or 0),
                    "modified": format_device_mtime(stat.get("st_mtime")),
                })
            items.sort(key=lambda item: (not item["is_dir"], item["name"].casefold()))
            return {"path": clean_path, "items": items}
        finally:
            await asyncio.to_thread(documents.close)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=404, detail=f"Could not open Companion Documents: {exc}")


@router.post("/api/companion/upload")
async def upload_companion_file(file: UploadFile = File(...), destination_path: str = Form(COMPANION_PORTABLE_ROOT)):
    try:
        directory = normalize_companion_path(destination_path)
        filename = safe_filename(file.filename or "portable-file.bin")
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    handle, temporary = tempfile.mkstemp(prefix="companion-upload-", dir=TEMP_CACHE_DIR)
    os.close(handle)
    documents = None
    try:
        with open(temporary, "wb") as output:
            while chunk := await file.read(TRANSFER_CHUNK_SIZE):
                output.write(chunk)
        documents = await asyncio.to_thread(open_companion_documents)
        remote_path = normalize_companion_path(posixpath.join(directory, filename))
        if not await asyncio.to_thread(documents.exists, directory):
            await asyncio.to_thread(documents.makedirs, directory)
        if await asyncio.to_thread(documents.exists, remote_path):
            raise HTTPException(status_code=409, detail="A Companion file with this name already exists.")
        try:
            await asyncio.to_thread(documents.push, temporary, remote_path, progress_bar=False)
        except TypeError:
            await asyncio.to_thread(documents.push, temporary, remote_path)
        return {"success": True, "path": remote_path, "bytes": os.path.getsize(temporary)}
    finally:
        if documents:
            await asyncio.to_thread(documents.close)
        try:
            os.remove(temporary)
        except FileNotFoundError:
            pass
        await file.close()


@router.get("/api/companion/download")
async def download_companion_file(path: str):
    try:
        clean_path = normalize_companion_path(path)
        documents = await asyncio.to_thread(open_companion_documents)
        try:
            stat = await asyncio.to_thread(documents.stat, clean_path)
            if is_afc_directory(stat):
                raise HTTPException(status_code=400, detail="Choose a Companion file, not a folder.")
            filename = safe_filename(posixpath.basename(clean_path))
            destination = os.path.join(TEMP_CACHE_DIR, "companion-" + hashlib.sha256(clean_path.encode()).hexdigest()[:12] + os.path.splitext(filename)[1])
            service_bridge = CompanionServiceBridge(documents)
            await asyncio.to_thread(copy_afc_file, clean_path, destination, int(stat.get("st_size", 0) or 0), service_bridge)
        finally:
            await asyncio.to_thread(documents.close)
        return FileResponse(destination, filename=filename, media_type="application/octet-stream")
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=404, detail=f"Could not download Companion file: {exc}")
