"""Connection, driver, kernel, service, and mount API routes."""

from fastapi import APIRouter
from app_core import *
from app_device import *
from app_mount_service import *
from app_media_service import ensure_connected, locate_media_library
from app_afc_transfer import get_registered_track
from fabric_runtime import DIAGNOSTIC_ANALYTICS, device_key

router = APIRouter()

@router.get("/api/status")
def get_status():
    """Return connection status after verifying any cached AFC session."""
    local_ip = get_local_ip()

    if bridge.connected:
        bridge.probe()
    # If disconnected, try once silently (respects rate-limit internally)
    if not bridge.connected:
        bridge.connect()

    device_key = None
    if bridge.device_info.get("UniqueDeviceID"):
        device_key = hashlib.sha256(str(bridge.device_info["UniqueDeviceID"]).encode()).hexdigest()[:16]
    CONNECTION_TIMELINE.record(
        "AFC_READY" if bridge.connected else "DISCONNECTED",
        device_key,
        "USB AFC session available" if bridge.connected else bridge._last_error_message,
    )

    return {
        "connected": bridge.connected,
        "mode": bridge.connection_mode,
        "message": bridge._last_error_message if not bridge.connected else f"Connected: {bridge.device_info.get('DeviceName', 'iPhone')}",
        "device_info": bridge.device_info,
        "local_ip": local_ip,
        "default_export_directory": default_export_directory(),
        "server_scope": "this PC only",
        "has_mutagen": HAS_MUTAGEN,
        "has_pymobiledevice": HAS_PYMOBILEDEVICE,
        "pymobiledevice_async_api": PYMOBILEDEVICE_ASYNC,
    }


@router.get("/api/diagnostics/hardware")
async def get_hardware_diagnostics():
    return await asyncio.to_thread(windows_hardware_diagnostics)


@router.get("/api/diagnostics/kernel")
async def get_kernel_diagnostics():
    return await asyncio.to_thread(windows_kernel_snapshot)


@router.post("/api/diagnostics/kernel/export")
async def export_kernel_diagnostics():
    snapshot = await asyncio.to_thread(windows_kernel_snapshot)
    output_dir = os.path.join(DATA_DIR, "diagnostics")
    os.makedirs(output_dir, exist_ok=True)
    path = os.path.join(output_dir, f"kernel-snapshot-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json")
    with open(path, "w", encoding="utf-8") as output:
        json.dump(snapshot, output, indent=2, default=str)
    return {"success": True, "path": path, "snapshot": snapshot}


@router.get("/api/diagnostics/timeline")
def get_connection_timeline(limit: int = 200):
    events = CONNECTION_TIMELINE.events(limit)
    return {"count": len(events), "events": events}


@router.post("/api/diagnostics/cable-benchmark")
async def cable_benchmark(request: Request):
    data = await request.json()
    ensure_connected()
    track_id = data.get("track_id")
    if track_id:
        track = get_registered_track(str(track_id))
        if not track:
            raise HTTPException(status_code=404, detail="Benchmark track is not in the catalog.")
        source_path = track["iphone_path"]
    else:
        try:
            source_path = locate_media_library()
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
    maximum = max(1024 * 1024, min(int(data.get("max_bytes", 64 * 1024 * 1024)), 256 * 1024 * 1024))
    try:
        result = await asyncio.to_thread(benchmark_afc, bridge.afc, source_path, maximum)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    CONNECTION_TIMELINE.record(
        "CABLE_BENCHMARK", None, f"{result['throughput_mbps']} MiB/s; health={result['health']}"
    )
    await asyncio.to_thread(DIAGNOSTIC_ANALYTICS.record, result, device_key(), None)
    result["predictive_health"] = await asyncio.to_thread(DIAGNOSTIC_ANALYTICS.prediction, device_key())
    return result


@router.get("/api/diagnostics/usb-trace")
def usb_trace_status():
    return USB_ETW.status()


@router.post("/api/diagnostics/usb-trace/start")
async def start_usb_trace():
    try:
        result = await asyncio.to_thread(USB_ETW.start)
        CONNECTION_TIMELINE.record("USB_TRACE_STARTED", None, result.get("etl_path"))
        return result
    except (OSError, PermissionError) as exc:
        raise HTTPException(
            status_code=403,
            detail=f"Windows could not start the kernel USB trace. Run iDrivePulse as Administrator: {exc}",
        )


@router.post("/api/diagnostics/usb-trace/stop")
async def stop_usb_trace():
    try:
        result = await asyncio.to_thread(USB_ETW.stop)
        CONNECTION_TIMELINE.record("USB_TRACE_STOPPED", None, result.get("etl_path"))
        return result
    except (OSError, PermissionError) as exc:
        raise HTTPException(status_code=403, detail=f"Windows could not stop the kernel USB trace: {exc}")


def apple_service_names() -> set[str]:
    script = (
        "$items=Get-CimInstance Win32_Service | Where-Object { "
        "$_.Name -match 'Apple|Bonjour|usbmux' -or $_.DisplayName -match 'Apple|Bonjour' }; "
        "@($items | Select-Object -ExpandProperty Name) | ConvertTo-Json -Compress"
    )
    result = run_powershell_json(script)
    if isinstance(result, str):
        return {result}
    return {str(value) for value in (result or [])}


@router.post("/api/system/services/{service_name}/{action}")
async def control_apple_service(service_name: str, action: str):
    if action not in {"start", "stop", "restart"}:
        raise HTTPException(status_code=400, detail="Service action must be start, stop, or restart.")
    allowed = await asyncio.to_thread(apple_service_names)
    if service_name not in allowed:
        raise HTTPException(status_code=403, detail="Only detected Apple device services can be controlled.")

    def run_action():
        commands = []
        if action in {"stop", "restart"}:
            commands.append(["sc.exe", "stop", service_name])
        if action in {"start", "restart"}:
            commands.append(["sc.exe", "start", service_name])
        outputs = []
        for command in commands:
            process = subprocess.run(
                command, capture_output=True, text=True, timeout=30,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            outputs.append((process.stdout or process.stderr).strip())
            if process.returncode not in {0, 1062}:
                raise PermissionError(outputs[-1] or f"sc.exe returned {process.returncode}")
        return outputs

    try:
        output = await asyncio.to_thread(run_action)
        CONNECTION_TIMELINE.record("SERVICE_CONTROL", None, f"{action} {service_name}")
        return {"success": True, "service": service_name, "action": action, "output": output}
    except (OSError, PermissionError, subprocess.TimeoutExpired) as exc:
        raise HTTPException(status_code=403, detail=f"Service control requires Administrator rights: {exc}")


@router.post("/api/system/apple-device/restart")
async def restart_apple_usb_device():
    if any(job["status"] in {"queued", "running"} for job in RECOVERY_QUEUE.list_jobs()):
        raise HTTPException(status_code=409, detail="Pause active recoveries before restarting the USB device stack.")
    if get_mount_status().get("mounted"):
        raise HTTPException(status_code=409, detail="Unmount the iPhone drive before restarting its USB device.")
    snapshot = await asyncio.to_thread(windows_kernel_snapshot)
    topology = snapshot.get("usb_topology") or []
    if isinstance(topology, dict):
        topology = [topology]
    composite = next(
        (
            item for item in topology
            if str(item.get("InstanceId", "")).upper().startswith("USB\\VID_05AC")
            and "COMPOSITE" in str(item.get("FriendlyName", "")).upper()
        ),
        None,
    )
    if not composite:
        raise HTTPException(status_code=404, detail="The Apple USB composite device is not currently present.")
    process = await asyncio.to_thread(
        subprocess.run,
        ["pnputil.exe", "/restart-device", composite["InstanceId"]],
        capture_output=True, text=True, timeout=45,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if process.returncode != 0:
        raise HTTPException(status_code=403, detail=(process.stderr or process.stdout or "Device restart failed.").strip())
    bridge.disconnect()
    CONNECTION_TIMELINE.record("USB_DEVICE_RESTARTED", None, composite.get("FriendlyName"))
    return {"success": True, "device": composite.get("FriendlyName"), "output": process.stdout.strip()}


@router.get("/api/mount/status")
def mount_status_endpoint():
    return get_mount_status()


@router.post("/api/mount/start")
async def mount_start_endpoint(request: Request):
    data = await request.json()
    try:
        drive = normalize_mount_drive(data.get("drive", "I:"))
    except (AttributeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    await asyncio.to_thread(ensure_connected)
    try:
        return await asyncio.to_thread(start_mount_process, drive)
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=f"Could not mount the iPhone: {exc}")


@router.post("/api/mount/stop")
async def mount_stop_endpoint():
    return await asyncio.to_thread(stop_mount_process)


@router.post("/api/connect")
def connect_device():
    """Explicit user-initiated connect/reconnect — forces a fresh attempt."""
    success, message = bridge.connect(force=True)
    device_key = None
    if bridge.device_info.get("UniqueDeviceID"):
        device_key = hashlib.sha256(str(bridge.device_info["UniqueDeviceID"]).encode()).hexdigest()[:16]
    CONNECTION_TIMELINE.record("AFC_READY" if success else "CONNECT_FAILED", device_key, message)
    return {
        "success": success,
        "message": message,
        "connected": bridge.connected,
        "mode": bridge.connection_mode,
        "device_info": bridge.device_info
    }
