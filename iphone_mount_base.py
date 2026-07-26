"""WinFsp drive-letter view of an iPhone's AFC media root.

The entire AFC tree is readable. Mutations are confined to the dedicated
``/Downloads/iDrivePulse Portable Files`` directory enforced by app.py.
"""

import argparse
import atexit
import hashlib
import os
import shutil
import signal
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone

from winfspy import (
    BaseFileSystemOperations,
    CREATE_FILE_CREATE_OPTIONS,
    FILE_ATTRIBUTE,
    FileSystem,
    NTStatusAccessDenied,
    NTStatusDirectoryNotEmpty,
    NTStatusEndOfFile,
    NTStatusMediaWriteProtected,
    NTStatusNotADirectory,
    NTStatusObjectNameCollision,
    NTStatusObjectNameNotFound,
)
from winfspy.plumbing.security_descriptor import SecurityDescriptor
from winfspy.plumbing.win32_filetime import dt_to_filetime, filetime_now

from app import (
    DATA_DIR,
    IPhoneBridge,
    MEDIA_CATALOG,
    PORTABLE_FILES_ROOT,
    TRANSFER_CHUNK_SIZE,
    is_afc_directory,
    normalize_afc_path,
    require_portable_write_path,
    safe_component,
)
from range_cache import RangeCache


FSP_CLEANUP_DELETE = 0x01
VIRTUAL_LIBRARY_ROOT = "/iDrivePulse Music Library"


def validate_mountpoint(value: str) -> str:
    value = (value or "").strip().upper()
    if len(value) == 1 and "D" <= value <= "Z":
        value += ":"
    if len(value) != 2 or value[1] != ":" or not ("D" <= value[0] <= "Z"):
        raise ValueError("Mount point must be an unused drive letter from D: through Z:.")
    return value


def windows_to_afc_path(file_name: str) -> str:
    return normalize_afc_path(str(file_name or "/").replace("\\", "/"))


def afc_time_to_filetime(value) -> int:
    if isinstance(value, datetime):
        moment = value
    else:
        try:
            numeric = float(value)
            if numeric > 10**12:
                numeric /= 10**9
            moment = datetime.fromtimestamp(numeric, tz=timezone.utc)
        except (TypeError, ValueError, OSError, OverflowError):
            return filetime_now()
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return dt_to_filetime(moment)


@dataclass
class AFCFileContext:
    path: str
    is_dir: bool
    size: int
    mtime: int
    afc_handle: int | None = None
    local_path: str | None = None
    dirty: bool = False
    deleted: bool = False
    remote_path: str | None = None
    virtual: bool = False


class MountOperationsBase(BaseFileSystemOperations):
    """Translate Windows filesystem calls into the trusted AFC media service."""

    def __init__(self, device_bridge: IPhoneBridge, cache_dir: str, virtual_tracks=None):
        super().__init__()
        self.bridge = device_bridge
        self.cache_dir = cache_dir
        self._lock = threading.RLock()
        self._pending: dict[str, AFCFileContext] = {}
        self._security = SecurityDescriptor.from_string("O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;WD)")
        self._virtual_files: dict[str, dict] = {}
        self._virtual_dirs: set[str] = {VIRTUAL_LIBRARY_ROOT}
        self._virtual_tracks_override = virtual_tracks
        self._virtual_loaded_at = 0.0
        quota = int(os.environ.get("IDRIVEPULSE_HYDRATION_QUOTA_BYTES", str(20 * 1024**3)))
        self.range_cache = RangeCache(os.path.join(DATA_DIR, "hydration-cache"), quota_bytes=quota)
        self._refresh_virtual_library(force=True)

    @staticmethod
    def _virtual_file_name(track: dict) -> str:
        extension = str(track.get("extension") or os.path.splitext(str(track.get("original_filename") or ""))[1] or ".audio")
        title = safe_component(str(track.get("title") or os.path.splitext(str(track.get("original_filename") or "Recovered Track"))[0]), "Recovered Track")
        return title if title.lower().endswith(extension.lower()) else f"{title}{extension}"

    def _add_virtual_file(self, directory: str, filename: str, track: dict):
        directory = normalize_afc_path(directory)
        path = normalize_afc_path(f"{directory}/{filename}")
        if path.casefold() in {value.casefold() for value in self._virtual_files}:
            stem, extension = os.path.splitext(filename)
            filename = f"{stem} [{str(track.get('id') or 'track')[-6:]}]{extension}"
            path = normalize_afc_path(f"{directory}/{filename}")
        self._virtual_files[path] = track
        current = directory
        while current.startswith(VIRTUAL_LIBRARY_ROOT):
            self._virtual_dirs.add(current)
            if current == VIRTUAL_LIBRARY_ROOT:
                break
            current = normalize_afc_path(os.path.dirname(current).replace("\\", "/"))

    def _refresh_virtual_library(self, force=False):
        if not force and time.time() - self._virtual_loaded_at < 5:
            return
        tracks = self._virtual_tracks_override
        if tracks is None:
            try:
                tracks = MEDIA_CATALOG.query_tracks()
            except Exception:
                tracks = []
        files: dict[str, dict] = {}
        directories = {VIRTUAL_LIBRARY_ROOT}
        self._virtual_files, self._virtual_dirs = files, directories
        for track in tracks or []:
            if not track.get("iphone_path"):
                continue
            filename = self._virtual_file_name(track)
            artist = safe_component(str(track.get("artist") or "Unknown Artist"), "Unknown Artist")
            album = safe_component(str(track.get("album") or "Unknown Album"), "Unknown Album")
            self._add_virtual_file(f"{VIRTUAL_LIBRARY_ROOT}/All Music", filename, track)
            self._add_virtual_file(f"{VIRTUAL_LIBRARY_ROOT}/Artists/{artist}", filename, track)
            self._add_virtual_file(f"{VIRTUAL_LIBRARY_ROOT}/Albums/{album}", filename, track)
            for playlist in track.get("playlists") or []:
                playlist_name = safe_component(str(playlist), "Unnamed Playlist")
                self._add_virtual_file(f"{VIRTUAL_LIBRARY_ROOT}/Playlists/{playlist_name}", filename, track)
            extension = safe_component(str(track.get("extension") or "Unknown").lstrip(".").upper(), "Unknown")
            self._add_virtual_file(f"{VIRTUAL_LIBRARY_ROOT}/Formats/{extension}", filename, track)
            bpm = track.get("bpm")
            if bpm:
                bucket = f"{int(float(bpm) // 10) * 10}-{int(float(bpm) // 10) * 10 + 9} BPM"
                self._add_virtual_file(f"{VIRTUAL_LIBRARY_ROOT}/BPM/{bucket}", filename, track)
            if track.get("metadata_pending"):
                self._add_virtual_file(f"{VIRTUAL_LIBRARY_ROOT}/Mystery Tracks", filename, track)
            try:
                analysis = MEDIA_CATALOG.get_analysis(str(track.get("id") or "")) or {}
                if analysis.get("key"):
                    key_name = safe_component(str(analysis["key"]), "Unknown Key")
                    self._add_virtual_file(f"{VIRTUAL_LIBRARY_ROOT}/Keys/{key_name}", filename, track)
            except Exception:
                pass
        self._virtual_loaded_at = time.time()

    def _is_virtual(self, path: str) -> bool:
        return path == VIRTUAL_LIBRARY_ROOT or path.startswith(VIRTUAL_LIBRARY_ROOT + "/")

    def _virtual_children(self, directory: str) -> set[str]:
        prefix = directory.rstrip("/") + "/"
        children = set()
        for path in self._virtual_dirs.union(self._virtual_files):
            if path.startswith(prefix):
                remainder = path[len(prefix):]
                if remainder:
                    children.add(remainder.split("/", 1)[0])
        return children

    def _attributes(self, is_dir: bool) -> int:
        if is_dir:
            return FILE_ATTRIBUTE.FILE_ATTRIBUTE_DIRECTORY
        return FILE_ATTRIBUTE.FILE_ATTRIBUTE_ARCHIVE

    def _file_info(self, context: AFCFileContext) -> dict:
        size = context.size
        if context.local_path and os.path.exists(context.local_path):
            size = os.path.getsize(context.local_path)
            context.size = size
        allocation_size = ((size + 4095) // 4096) * 4096 if size else 0
        return {
            "file_attributes": self._attributes(context.is_dir),
            "allocation_size": allocation_size,
            "file_size": size,
            "creation_time": context.mtime,
            "last_access_time": context.mtime,
            "last_write_time": context.mtime,
            "change_time": context.mtime,
            "index_number": int(hashlib.sha256(context.path.encode("utf-8")).hexdigest()[:15], 16),
        }

    def _context_from_stat(self, path: str) -> AFCFileContext:
        self._refresh_virtual_library()
        pending = self._pending.get(path)
        if pending:
            return pending
        if path in self._virtual_dirs:
            return AFCFileContext(path=path, is_dir=True, size=0, mtime=filetime_now(), virtual=True)
        virtual_track = self._virtual_files.get(path)
        if virtual_track:
            remote_path = normalize_afc_path(virtual_track["iphone_path"])
            try:
                info = self.bridge.afc.stat(remote_path)
            except Exception:
                raise NTStatusObjectNameNotFound()
            return AFCFileContext(
                path=path, is_dir=False, size=int(info.get("st_size", virtual_track.get("size_bytes", 0)) or 0),
                mtime=afc_time_to_filetime(info.get("st_mtime", 0)), remote_path=remote_path, virtual=True,
            )
        try:
            info = self.bridge.afc.stat(path)
        except Exception:
            raise NTStatusObjectNameNotFound()
        return AFCFileContext(
            path=path,
            is_dir=is_afc_directory(info),
            size=int(info.get("st_size", 0) or 0),
            mtime=afc_time_to_filetime(info.get("st_mtime", 0)),
        )

    def _assert_writable(self, path: str, *, allow_root: bool = True) -> str:
        try:
            return require_portable_write_path(path, allow_root=allow_root)
        except ValueError:
            raise NTStatusMediaWriteProtected()

    def _commit(self, context: AFCFileContext):
        if not context.dirty or context.deleted or not context.local_path:
            return
        self._assert_writable(context.path)
        if self.bridge.afc.exists(context.path):
            raise NTStatusObjectNameCollision()
        try:
            self.bridge.afc.push(context.local_path, context.path, progress_bar=False)
        except TypeError:
            self.bridge.afc.push(context.local_path, context.path)
        context.size = os.path.getsize(context.local_path)
        context.dirty = False
        self._pending.pop(context.path, None)
