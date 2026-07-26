"""Read-only discovery and selective extraction of Apple Devices backups."""

from __future__ import annotations

import hashlib
import os
import plistlib
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable


AUDIO_EXTENSIONS = frozenset({
    ".mp2", ".mp3", ".m4a", ".aac", ".wav", ".flac", ".aiff", ".aif", ".caf", ".alac", ".ogg", ".opus"
})
PROJECT_EXTENSIONS = frozenset({
    ".als", ".alp", ".flp", ".logicx", ".band", ".ptx", ".ptf", ".rpp", ".song", ".cpr", ".mid", ".midi", ".zip"
})


def default_backup_roots(home: str | None = None) -> list[str]:
    home = os.path.abspath(home or os.path.expanduser("~"))
    candidates = [
        os.path.join(home, "Apple", "MobileSync", "Backup"),
        os.path.join(home, "AppData", "Roaming", "Apple Computer", "MobileSync", "Backup"),
        os.path.join(home, "Library", "Application Support", "MobileSync", "Backup"),
    ]
    return list(dict.fromkeys(os.path.normcase(os.path.abspath(path)) for path in candidates))


def _plist(path: str) -> dict:
    try:
        with open(path, "rb") as source:
            value = plistlib.load(source)
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, OSError, plistlib.InvalidFileException):
        return {}


def _text(value) -> str | None:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return str(value) if value not in (None, "") else None


def backup_file_path(backup_path: str, file_id: str) -> str:
    nested = os.path.join(backup_path, file_id[:2], file_id)
    flat = os.path.join(backup_path, file_id)
    return nested if os.path.isfile(nested) else flat


class BackupFusion:
    def __init__(self, roots: Iterable[str] | None = None):
        self.roots = [os.path.abspath(path) for path in (roots or default_backup_roots())]

    def discover(self) -> list[dict]:
        results = []
        for root in self.roots:
            if not os.path.isdir(root):
                continue
            for entry in os.scandir(root):
                if not entry.is_dir() or not os.path.isfile(os.path.join(entry.path, "Manifest.plist")):
                    continue
                manifest = _plist(os.path.join(entry.path, "Manifest.plist"))
                info = _plist(os.path.join(entry.path, "Info.plist"))
                status = _plist(os.path.join(entry.path, "Status.plist"))
                encrypted = bool(manifest.get("IsEncrypted"))
                results.append({
                    "id": entry.name, "path": entry.path, "device_name": info.get("Device Name") or info.get("Display Name"),
                    "product_type": info.get("Product Type"), "ios_version": info.get("Product Version"),
                    "serial_hash": hashlib.sha256(str(info.get("Serial Number") or entry.name).encode()).hexdigest()[:16],
                    "last_backup": _text(info.get("Last Backup Date") or status.get("Date")),
                    "encrypted": encrypted, "state": "locked" if encrypted else "ready",
                    "manifest_database": os.path.isfile(os.path.join(entry.path, "Manifest.db")),
                })
        return sorted(results, key=lambda item: item.get("last_backup") or "", reverse=True)

    def get(self, backup_id: str) -> dict | None:
        return next((item for item in self.discover() if item["id"] == backup_id), None)

    @staticmethod
    def _metadata(blob: bytes | None) -> dict:
        if not blob:
            return {}
        try:
            value = plistlib.loads(blob)
            return value if isinstance(value, dict) else {}
        except (plistlib.InvalidFileException, ValueError, TypeError):
            return {}

    def scan(self, backup_id: str, include_all: bool = False, limit: int = 100_000) -> list[dict]:
        backup = self.get(backup_id)
        if not backup:
            raise FileNotFoundError("Apple backup not found.")
        if backup["encrypted"]:
            raise PermissionError("This backup is encrypted. Unlock support requires the owner's password and a compatible keybag backend.")
        database = os.path.join(backup["path"], "Manifest.db")
        if not os.path.isfile(database):
            raise FileNotFoundError("Manifest.db is missing from this backup.")
        uri = Path(database).resolve().as_uri() + "?mode=ro"
        connection = sqlite3.connect(uri, uri=True)
        connection.row_factory = sqlite3.Row
        try:
            rows = connection.execute(
                "SELECT fileID, domain, relativePath, flags, file FROM Files WHERE relativePath <> '' LIMIT ?",
                (max(1, min(int(limit), 500_000)),),
            )
            assets = []
            for row in rows:
                relative = str(row["relativePath"] or "").replace("\\", "/")
                extension = os.path.splitext(relative)[1].lower()
                if not include_all and extension not in AUDIO_EXTENSIONS | PROJECT_EXTENSIONS:
                    continue
                physical = backup_file_path(backup["path"], row["fileID"])
                if not os.path.isfile(physical):
                    continue
                metadata = self._metadata(row["file"])
                assets.append({
                    "id": f"backup:{backup_id}:{row['fileID']}", "backup_id": backup_id, "file_id": row["fileID"],
                    "source_kind": "apple_backup", "domain": row["domain"], "relative_path": relative,
                    "name": os.path.basename(relative), "extension": extension, "physical_path": physical,
                    "size_bytes": os.path.getsize(physical), "modified": _text(metadata.get("LastModified")),
                })
            return assets
        finally:
            connection.close()

    def extract(self, backup_id: str, file_ids: list[str], output_directory: str) -> list[dict]:
        output_directory = os.path.abspath(output_directory)
        os.makedirs(output_directory, exist_ok=True)
        allowed = {asset["file_id"]: asset for asset in self.scan(backup_id, include_all=True) if asset["file_id"] in set(file_ids)}
        results = []
        for file_id in dict.fromkeys(file_ids):
            asset = allowed.get(file_id)
            if not asset:
                continue
            relative_parts = [part for part in Path(asset["relative_path"]).parts if part not in {"..", ".", "/", "\\"}]
            destination = os.path.abspath(os.path.join(output_directory, *relative_parts))
            if os.path.commonpath([output_directory, destination]) != output_directory:
                raise ValueError("Unsafe backup path.")
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            if os.path.exists(destination):
                stem, extension = os.path.splitext(destination)
                destination = f"{stem} [{file_id[:8]}]{extension}"
            shutil.copy2(asset["physical_path"], destination)
            digest = hashlib.sha256(Path(destination).read_bytes()).hexdigest()
            results.append({"file_id": file_id, "path": destination, "bytes": os.path.getsize(destination), "sha256": digest})
        return results
