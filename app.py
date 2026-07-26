"""iDrivePulse FastAPI composition root and backward-compatible public API."""

import contextlib
import urllib.parse

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app_core import *
from app_device import *
from app_afc_transfer import copy_afc_file, get_registered_track
from app_media_service import *
from app_media_service import _track_from_stat
from app_media_router import cache_track
from app_mount_service import *
from app_recovery_worker import *
from app_sync_service import *
from app_transfer_router import *

import app_companion_router
import app_afc_transfer
import app_diagnostics_router
import app_drive_router
import app_fabric_router
import app_media_router
import app_media_service
import app_mount_service
import app_project_router
import app_recovery_router
import app_recovery_worker
import app_sync_router
import app_sync_service
import app_transfer_router
import fabric_runtime


@contextlib.asynccontextmanager
async def app_lifespan(_application):
    if any(profile["enabled"] for profile in PORTABLE_SYNC.list_profiles()):
        app_sync_service.ensure_portable_sync_scheduler()
    try:
        await asyncio.to_thread(fabric_runtime.DEVICE_EVENTS.start)
    except Exception as exc:
        CONNECTION_TIMELINE.record("DEVICE_EVENTS_FAILED", None, str(exc)[:1000])
    try:
        yield
    finally:
        await asyncio.to_thread(fabric_runtime.DEVICE_EVENTS.stop)
        if fabric_runtime.WIRELESS_SERVER.status()["running"]:
            await asyncio.to_thread(fabric_runtime.WIRELESS_SERVER.stop)
        SYNC_SCHEDULER_STOP.set()
        if USB_ETW.status().get("recording"):
            try:
                await asyncio.to_thread(USB_ETW.stop)
            except Exception:
                pass


app = FastAPI(
    title="iDrivePulse - iPhone Portable Drive & Beat Extractor",
    version="6.0.0",
    lifespan=app_lifespan,
)

ROUTE_MODULES = (
    app_diagnostics_router,
    app_media_router,
    app_transfer_router,
    app_recovery_router,
    app_project_router,
    app_sync_router,
    app_drive_router,
    app_companion_router,
    app_fabric_router,
)
BRIDGE_CONSUMERS = ROUTE_MODULES + (
    app_afc_transfer,
    app_media_service,
    app_mount_service,
    app_recovery_worker,
    app_sync_service,
    fabric_runtime,
)

for route_module in ROUTE_MODULES:
    app.include_router(route_module.router)


@app.middleware("http")
async def protect_local_api(request: Request, call_next):
    """Synchronize the injectable bridge and reject cross-site API calls."""
    active_bridge = globals()["bridge"]
    for module in BRIDGE_CONSUMERS:
        if hasattr(module, "bridge"):
            module.bridge = active_bridge

    if request.url.path.startswith("/api/"):
        origin = request.headers.get("origin")
        fetch_site = request.headers.get("sec-fetch-site", "")
        if fetch_site == "cross-site":
            return JSONResponse(status_code=403, content={"detail": "Cross-site API requests are not allowed."})
        if origin:
            origin_parts = urllib.parse.urlsplit(origin)
            if origin_parts.netloc.lower() != request.headers.get("host", "").lower():
                return JSONResponse(status_code=403, content={"detail": "Cross-origin API requests are not allowed."})
    return await call_next(request)


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    print("iDrivePulse v6.0 — http://127.0.0.1:8765")
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")
