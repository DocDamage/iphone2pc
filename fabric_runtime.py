"""Long-lived Recovery Fabric services shared by the API and device callbacks."""

from __future__ import annotations

import hashlib
import os
import subprocess

from app_core import CONNECTION_TIMELINE, DATA_DIR, MEDIA_CATALOG
from app_device import bridge
from backup_fusion import BackupFusion
from beat_graph import BeatGraph
from chunk_vault import ChunkVault
from device_events import DeviceEventEngine
from diagnostic_analytics import DiagnosticAnalytics
from local_ai_runtime import LocalAIRuntime
from provenance import ProvenanceService
from range_cache import RangeCache
from wireless_exchange import WIRELESS_SERVER


CHUNK_VAULT = ChunkVault(os.path.join(DATA_DIR, "content-vault"))
BACKUP_FUSION = BackupFusion()
BEAT_GRAPH = BeatGraph(MEDIA_CATALOG.database_path)
LOCAL_AI = LocalAIRuntime(os.path.join(DATA_DIR, "models"))
PROVENANCE = ProvenanceService(os.path.join(DATA_DIR, "provenance", "owner-key.dpapi"))
DIAGNOSTIC_ANALYTICS = DiagnosticAnalytics(os.path.join(DATA_DIR, "diagnostic-history.sqlite3"))
HYDRATION_CACHE = RangeCache(
    os.path.join(DATA_DIR, "hydration-cache"),
    quota_bytes=int(os.environ.get("IDRIVEPULSE_HYDRATION_QUOTA", 20 * 1024**3)),
)


def device_key() -> str | None:
    identifier = bridge.device_info.get("UniqueDeviceID")
    return hashlib.sha256(str(identifier).encode()).hexdigest()[:16] if identifier else None


def iphone_present() -> bool:
    """Probe Windows' PnP tree without opening or disturbing the AFC session."""
    if os.name != "nt":
        return bool(bridge.connected)
    command = [
        "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
        "[bool](Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | "
        "Where-Object InstanceId -like '*VID_05AC*')",
    ]
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return result.stdout.strip().casefold() == "true"
    except (OSError, subprocess.TimeoutExpired):
        return bool(bridge.connected)


def handle_device_event(event: str) -> None:
    """Record a PnP transition and resume only work the owner already queued."""
    event = str(event).casefold()
    if event not in {"arrival", "removal"}:
        raise ValueError("Device event must be arrival or removal.")
    if event == "arrival":
        success, message = bridge.connect(force=True)
        CONNECTION_TIMELINE.record("PNP_ARRIVAL", device_key(), message)
        if success:
            from app_recovery_worker import ensure_recovery_worker
            ensure_recovery_worker()
    else:
        CONNECTION_TIMELINE.record("PNP_REMOVAL", device_key(), "Apple USB device removed")


DEVICE_EVENTS = DeviceEventEngine(iphone_present, handle_device_event)


def fabric_status() -> dict:
    return {
        "version": 1,
        "device_events": DEVICE_EVENTS.status(),
        "vault": CHUNK_VAULT.stats(),
        "backups": len(BACKUP_FUSION.discover()),
        "intelligence": {
            "catalog_database": MEDIA_CATALOG.database_path,
            "local_ai": LOCAL_AI.status(),
        },
        "provenance": PROVENANCE.status(),
        "diagnostics": DIAGNOSTIC_ANALYTICS.prediction(device_key()),
        "hydration": HYDRATION_CACHE.status(),
        "wireless": WIRELESS_SERVER.status(),
    }
