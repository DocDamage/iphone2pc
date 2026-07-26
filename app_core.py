import os
import sys
import json
import atexit
import contextlib
import ctypes
import shutil
import time
import zipfile
import urllib.parse
import socket
import sqlite3
import struct
import subprocess
import asyncio
import hashlib
import importlib.util
import inspect
import mimetypes
import posixpath
import tempfile
import threading
from datetime import datetime
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Form
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sse_starlette.sse import EventSourceResponse
from starlette.background import BackgroundTask
import uvicorn

from catalog import MediaCatalog, decode_media_library
from audio_analysis import analyze_audio
from hardware_diagnostics import ConnectionTimeline, ETWRecorder, benchmark_afc, windows_kernel_snapshot
from portable_sync import PortableSyncStore, resolve_conflict as resolve_portable_conflict, sync_once
from recovery import QueueStore, decrypt_vault, encrypt_to_vault, write_recovery_report

# Try importing mutagen for audio tag parsing
try:
    import mutagen
    from mutagen.easyid3 import EasyID3
    from mutagen.mp3 import MP3
    from mutagen.mp4 import MP4, MP4Cover
    from mutagen.flac import FLAC
    from mutagen.wave import WAVE
    HAS_MUTAGEN = True
except ImportError:
    HAS_MUTAGEN = False

# Try importing pymobiledevice3 for iOS USB connection
try:
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.house_arrest import HouseArrestService
    try:
        # pymobiledevice3 4.x-5.x exposed a synchronous, all-caps class.
        from pymobiledevice3.services.afc import AFCService
        PYMOBILEDEVICE_ASYNC = False
    except ImportError:
        # pymobiledevice3 6+ renamed the class and moved AFC onto asyncio.
        from pymobiledevice3.services.afc import AfcService as AFCService
        PYMOBILEDEVICE_ASYNC = True
    from pymobiledevice3.exceptions import NoDeviceConnectedError, PyMobileDevice3Exception
    HAS_PYMOBILEDEVICE = True
except ImportError:
    PYMOBILEDEVICE_ASYNC = False
    HAS_PYMOBILEDEVICE = False
    HouseArrestService = None

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMP_CACHE_ROOT = os.path.join(BASE_DIR, "temp_cache")
DATA_DIR = os.path.abspath(os.environ.get("IDRIVEPULSE_DATA_DIR", os.path.join(BASE_DIR, "data")))

os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(TEMP_CACHE_ROOT, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)
TEMP_CACHE_DIR = tempfile.mkdtemp(prefix=f"session_{os.getpid()}_", dir=TEMP_CACHE_ROOT)
MEDIA_CATALOG = MediaCatalog(os.path.join(DATA_DIR, "catalog.sqlite3"))
RECOVERY_QUEUE = QueueStore(os.path.join(DATA_DIR, "recovery-queue.sqlite3"))
PORTABLE_SYNC = PortableSyncStore(
    os.path.join(DATA_DIR, "portable-sync.sqlite3"), os.path.join(DATA_DIR, "portable-file-versions")
)
CONNECTION_TIMELINE = ConnectionTimeline(os.path.join(DATA_DIR, "connection-timeline.sqlite3"))
USB_ETW = ETWRecorder(os.path.join(DATA_DIR, "diagnostics"))

AUDIO_EXTENSIONS = frozenset({
    '.mp2', '.mp3', '.m4a', '.m4b', '.m4p', '.m4r', '.aac', '.wav', '.flac',
    '.aiff', '.aif', '.caf', '.alac', '.ogg', '.opus', '.wma', '.amr', '.3ga',
})
DEFAULT_SCAN_ROOTS = (
    "/iTunes_Control/Music",
    "/Downloads",
    "/Recordings",
    "/Books",
    "/Media/iTunes_Control/Music",
    "/",
)
TRANSFER_CHUNK_SIZE = 1024 * 1024
PORTABLE_FILES_ROOT = "/Downloads/iDrivePulse Portable Files"
RECOVERY_JOURNAL_FILENAME = ".idrivepulse-recovery.json"
RECOVERY_PARTIAL_DIRNAME = ".idrivepulse-partials"
DISK_RESERVE_MIN_BYTES = 512 * 1024 * 1024
TRACK_REGISTRY = {}
TRACK_REGISTRY_LOCK = threading.RLock()
TRACK_CACHE_LOCKS = {}
MOUNT_LOCK = threading.RLock()
MOUNT_PROCESS = None
MOUNT_DRIVE = None
MOUNT_STOP_FILE = None
MOUNT_LOG_PATH = None
RECOVERY_WORKER_LOCK = threading.RLock()
RECOVERY_WORKER_THREAD = None
SYNC_RUN_LOCK = threading.Lock()
SYNC_SCHEDULER_LOCK = threading.RLock()
SYNC_SCHEDULER_THREAD = None
SYNC_SCHEDULER_STOP = threading.Event()
atexit.register(SYNC_SCHEDULER_STOP.set)


def cleanup_stale_temp_cache(max_age_seconds=24 * 60 * 60):
    """Remove abandoned cache entries without touching another running session."""
    cutoff = time.time() - max_age_seconds
    try:
        for entry in os.scandir(TEMP_CACHE_ROOT):
            if os.path.abspath(entry.path) == os.path.abspath(TEMP_CACHE_DIR):
                continue
            try:
                if entry.stat(follow_symlinks=False).st_mtime >= cutoff:
                    continue
                if entry.is_dir(follow_symlinks=False):
                    shutil.rmtree(entry.path, ignore_errors=True)
                else:
                    os.remove(entry.path)
            except FileNotFoundError:
                continue
    except Exception as e:
        print(f"[Startup] Warning: Failed to clean stale temp cache: {e}")


def cleanup_session_temp_cache():
    shutil.rmtree(TEMP_CACHE_DIR, ignore_errors=True)


cleanup_stale_temp_cache()
atexit.register(cleanup_session_temp_cache)


# Helper function to get local IP address
def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def default_export_directory() -> str:
    return os.path.join(os.path.expanduser("~"), "Music", "Recovered_Beats")


def normalize_afc_path(path: str) -> str:
    """Return a canonical absolute POSIX path for the AFC media root."""
    if not isinstance(path, str) or "\x00" in path:
        raise ValueError("Invalid iPhone path.")
    normalized = posixpath.normpath("/" + path.replace("\\", "/").lstrip("/"))
    return normalized if normalized.startswith("/") else f"/{normalized}"


def is_within_afc_path(path: str, root: str) -> bool:
    """Return True when path is root or one of its descendants."""
    clean_path = normalize_afc_path(path)
    clean_root = normalize_afc_path(root)
    return clean_path == clean_root or clean_path.startswith(f"{clean_root}/")


def require_portable_write_path(path: str, *, allow_root: bool = True) -> str:
    """Confine every phone-side mutation to the dedicated portable folder."""
    clean_path = normalize_afc_path(path)
    if not is_within_afc_path(clean_path, PORTABLE_FILES_ROOT):
        raise ValueError(f"Writes are allowed only inside {PORTABLE_FILES_ROOT}.")
    if not allow_root and clean_path == PORTABLE_FILES_ROOT:
        raise ValueError("The Portable Files root cannot be modified or deleted.")
    return clean_path


def safe_filename(filename: str) -> str:
    """Strip paths and Windows-reserved punctuation from a user/device filename."""
    leaf = posixpath.basename((filename or "").replace("\\", "/")).strip()
    leaf = "".join("_" if c in '<>:"/\\|?*' or ord(c) < 32 else c for c in leaf)
    leaf = leaf.rstrip(" .")
    if leaf in {"", ".", ".."}:
        raise ValueError("A valid filename is required.")
    reserved_stem = os.path.splitext(leaf)[0].upper()
    is_numbered_device = (
        reserved_stem.startswith(("COM", "LPT"))
        and reserved_stem[3:].isdigit()
        and 1 <= int(reserved_stem[3:]) <= 9
    )
    if reserved_stem in {"CON", "PRN", "AUX", "NUL"} or is_numbered_device:
        leaf = f"_{leaf}"
    return leaf


def safe_component(value: str, fallback: str) -> str:
    try:
        component = safe_filename(value)
    except ValueError:
        component = fallback
    return component[:180]


def format_device_mtime(value) -> str:
    if isinstance(value, datetime):
        return value.astimezone().strftime("%Y-%m-%d %H:%M:%S")
    try:
        numeric = float(value)
        # Older pymobiledevice3 versions may return nanoseconds from the device.
        if numeric > 10**12:
            numeric /= 10**9
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(numeric))
    except (TypeError, ValueError, OSError, OverflowError):
        return "--"


def format_size(size: int) -> str:
    size = max(0, int(size or 0))
    units = ("B", "KB", "MB", "GB", "TB")
    amount = float(size)
    for unit in units:
        if amount < 1024 or unit == units[-1]:
            return f"{amount:.0f} {unit}" if unit == "B" else f"{amount:.1f} {unit}"
        amount /= 1024


def is_afc_directory(info: dict) -> bool:
    return info.get("st_ifmt") == "S_IFDIR" or bool(info.get("st_mode", 0) & 0o040000)


@contextlib.contextmanager
def transfer_power_guard():
    """Keep Windows awake while the calling transfer thread is active."""
    if sys.platform != "win32":
        yield
        return

    es_continuous = 0x80000000
    es_system_required = 0x00000001
    kernel32 = ctypes.windll.kernel32
    previous = kernel32.SetThreadExecutionState(es_continuous | es_system_required)
    if not previous:
        raise ctypes.WinError()
    try:
        yield
    finally:
        kernel32.SetThreadExecutionState(es_continuous)
