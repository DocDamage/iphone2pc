"""Versioned Portable Files synchronization scheduler and adapters."""

from app_core import *
from app_device import *
from app_media_service import *
from app_afc_transfer import copy_afc_file

def portable_sync_upload(local_path: str, remote_path: str) -> None:
    remote_path = require_portable_write_path(remote_path, allow_root=False)
    try:
        bridge.afc.push(local_path, remote_path, progress_bar=False)
    except TypeError:
        bridge.afc.push(local_path, remote_path)


def portable_sync_remove(remote_path: str) -> None:
    remote_path = require_portable_write_path(remote_path, allow_root=False)
    bridge.afc.rm(remote_path)


def run_portable_sync(profile_id: str) -> dict:
    ensure_connected()
    profile = PORTABLE_SYNC.get_profile(profile_id)
    if not profile:
        raise ValueError("Sync profile not found.")
    if normalize_afc_path(profile["remote_root"]) != PORTABLE_FILES_ROOT:
        raise ValueError("Portable sync is restricted to the dedicated writable folder.")
    with SYNC_RUN_LOCK:
        return sync_once(
            PORTABLE_SYNC, profile_id, bridge.afc, copy_afc_file, portable_sync_upload, portable_sync_remove
        )


def portable_sync_scheduler() -> None:
    global SYNC_SCHEDULER_THREAD
    try:
        while not SYNC_SCHEDULER_STOP.is_set():
            profiles = [profile for profile in PORTABLE_SYNC.list_profiles() if profile["enabled"]]
            if not profiles:
                break
            if bridge.connected and bridge.probe():
                for profile in profiles:
                    if SYNC_SCHEDULER_STOP.is_set():
                        break
                    try:
                        run_portable_sync(profile["id"])
                    except Exception:
                        pass
            SYNC_SCHEDULER_STOP.wait(30)
    finally:
        with SYNC_SCHEDULER_LOCK:
            SYNC_SCHEDULER_THREAD = None


def ensure_portable_sync_scheduler() -> None:
    global SYNC_SCHEDULER_THREAD
    with SYNC_SCHEDULER_LOCK:
        if SYNC_SCHEDULER_THREAD and SYNC_SCHEDULER_THREAD.is_alive():
            return
        SYNC_SCHEDULER_STOP.clear()
        SYNC_SCHEDULER_THREAD = threading.Thread(
            target=portable_sync_scheduler, name="idrivepulse-portable-sync", daemon=True
        )
        SYNC_SCHEDULER_THREAD.start()
