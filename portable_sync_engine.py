"""Conflict-safe execution engine for Portable Files synchronization."""

from __future__ import annotations

import os
import posixpath
import shutil
import tempfile
from pathlib import Path
from typing import Any, Callable

from portable_sync_store import PortableSyncStore, _hash, _now, _remote_mtime, _stamp

def _scan_local(root: str) -> dict[str, dict[str, Any]]:
    result = {}
    for directory, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name != ".idrivepulse-versions"]
        for filename in filenames:
            path = os.path.join(directory, filename)
            relative = os.path.relpath(path, root).replace(os.sep, "/")
            stat = os.stat(path)
            result[relative] = {"path": path, "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}
    return result


def _scan_remote(afc, root: str) -> dict[str, dict[str, Any]]:
    result, pending = {}, [root]
    while pending:
        directory = pending.pop(0)
        try:
            names = afc.listdir(directory)
        except Exception:
            continue
        for name in names:
            if name in {".", ".."}:
                continue
            path = posixpath.normpath(posixpath.join(directory, name))
            stat = afc.stat(path)
            is_dir = stat.get("st_ifmt") == "S_IFDIR" or bool(stat.get("st_mode", 0) & 0o040000)
            if is_dir:
                pending.append(path)
            else:
                relative = posixpath.relpath(path, root)
                result[relative] = {
                    "path": path, "size": int(stat.get("st_size", 0) or 0),
                    "mtime": _remote_mtime(stat.get("st_mtime")),
                }
    return result


def sync_once(
    store: PortableSyncStore,
    profile_id: str,
    afc,
    download: Callable[[str, str, int], Any],
    upload: Callable[[str, str], Any],
    remove_remote: Callable[[str], Any],
) -> dict[str, Any]:
    profile = store.get_profile(profile_id)
    if not profile:
        raise ValueError("Sync profile not found.")
    local_root, remote_root = profile["local_root"], profile["remote_root"]
    os.makedirs(local_root, exist_ok=True)
    if not afc.exists(remote_root):
        afc.makedirs(remote_root)
    local_files = _scan_local(local_root)
    remote_files = _scan_remote(afc, remote_root)
    previous = store.get_state(profile_id)
    result = {"profile_id": profile_id, "uploaded": 0, "downloaded": 0, "unchanged": 0, "conflicts": 0, "versions_created": 0, "errors": []}

    for relative in sorted(set(local_files).union(remote_files), key=str.casefold):
        local, remote, old = local_files.get(relative), remote_files.get(relative), previous.get(relative)
        try:
            if local and not remote:
                remote_path = posixpath.join(remote_root, relative)
                parent = posixpath.dirname(remote_path)
                if not afc.exists(parent):
                    afc.makedirs(parent)
                upload(local["path"], remote_path)
                remote = {"path": remote_path, "size": local["size"], "mtime": "uploaded:" + _now()}
                local["sha256"] = _hash(local["path"])
                result["uploaded"] += 1
            elif remote and not local:
                destination = os.path.join(local_root, *Path(relative).parts)
                os.makedirs(os.path.dirname(destination), exist_ok=True)
                download(remote["path"], destination, remote["size"])
                stat = os.stat(destination)
                local = {"path": destination, "size": stat.st_size, "mtime_ns": stat.st_mtime_ns, "sha256": _hash(destination)}
                result["downloaded"] += 1
            elif local and remote:
                local_changed = not old or local["size"] != old.get("local_size") or local["mtime_ns"] != old.get("local_mtime_ns")
                remote_changed = not old or remote["size"] != old.get("remote_size") or remote["mtime"] != old.get("remote_mtime")
                if not old:
                    handle, remote_temp = tempfile.mkstemp(prefix="idrivepulse-sync-")
                    os.close(handle)
                    try:
                        download(remote["path"], remote_temp, remote["size"])
                        local["sha256"] = _hash(local["path"])
                        if local["sha256"] == _hash(remote_temp):
                            local_changed = remote_changed = False
                    finally:
                        try:
                            os.remove(remote_temp)
                        except FileNotFoundError:
                            pass
                if local_changed and remote_changed:
                    store.add_conflict(profile_id, relative, {"local": local, "remote": remote})
                    result["conflicts"] += 1
                    continue
                if local_changed:
                    version = store.version_path(profile_id, "phone", relative)
                    download(remote["path"], version, remote["size"])
                    result["versions_created"] += 1
                    remove_remote(remote["path"])
                    upload(local["path"], remote["path"])
                    remote = {**remote, "size": local["size"], "mtime": "uploaded:" + _now()}
                    local["sha256"] = _hash(local["path"])
                    result["uploaded"] += 1
                elif remote_changed:
                    version = store.version_path(profile_id, "pc", relative)
                    shutil.copy2(local["path"], version)
                    result["versions_created"] += 1
                    download(remote["path"], local["path"], remote["size"])
                    stat = os.stat(local["path"])
                    local = {"path": local["path"], "size": stat.st_size, "mtime_ns": stat.st_mtime_ns, "sha256": _hash(local["path"])}
                    result["downloaded"] += 1
                else:
                    local["sha256"] = old.get("local_sha256") or _hash(local["path"])
                    result["unchanged"] += 1
            store.save_state(profile_id, relative, local, remote)
        except Exception as exc:
            result["errors"].append({"path": relative, "reason": str(exc)[:500]})
    store.record_result(profile_id, result)
    return result


def resolve_conflict(
    store: PortableSyncStore,
    conflict_id: str,
    choice: str,
    afc,
    download: Callable[[str, str, int], Any],
    upload: Callable[[str, str], Any],
    remove_remote: Callable[[str], Any],
) -> dict[str, Any]:
    if choice not in {"pc", "phone", "keep_both"}:
        raise ValueError("Conflict choice must be pc, phone, or keep_both.")
    conflict = store.get_conflict(conflict_id)
    if not conflict or conflict["status"] != "open":
        raise ValueError("Open sync conflict not found.")
    profile = store.get_profile(conflict["profile_id"])
    if not profile:
        raise ValueError("Sync profile not found.")
    relative = conflict["relative_path"]
    local_path = os.path.abspath(os.path.join(profile["local_root"], *Path(relative).parts))
    if os.path.commonpath([profile["local_root"], local_path]) != profile["local_root"]:
        raise ValueError("Unsafe conflict path.")
    remote_path = posixpath.normpath(posixpath.join(profile["remote_root"], relative))
    remote_stat = afc.stat(remote_path)
    remote = {
        "path": remote_path,
        "size": int(remote_stat.get("st_size", 0) or 0),
        "mtime": _remote_mtime(remote_stat.get("st_mtime")),
    }
    if choice == "pc":
        version = store.version_path(profile["id"], "phone", relative)
        download(remote_path, version, remote["size"])
        remove_remote(remote_path)
        upload(local_path, remote_path)
    elif choice == "phone":
        version = store.version_path(profile["id"], "pc", relative)
        shutil.copy2(local_path, version)
        download(remote_path, local_path, remote["size"])
    else:
        stem, extension = os.path.splitext(local_path)
        retained_path = f"{stem} (PC conflict {_stamp()}){extension}"
        os.replace(local_path, retained_path)
        download(remote_path, local_path, remote["size"])

    local_stat = os.stat(local_path)
    remote_stat = afc.stat(remote_path)
    local = {
        "path": local_path, "size": local_stat.st_size, "mtime_ns": local_stat.st_mtime_ns,
        "sha256": _hash(local_path),
    }
    remote = {
        "path": remote_path, "size": int(remote_stat.get("st_size", 0) or 0),
        "mtime": _remote_mtime(remote_stat.get("st_mtime")),
    }
    store.save_state(profile["id"], relative, local, remote)
    store.resolve_conflict(conflict_id)
    return {"conflict_id": conflict_id, "choice": choice, "relative_path": relative}
