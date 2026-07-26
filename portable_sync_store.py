"""Conflict-safe, versioned sync for the dedicated Portable Files folder."""

from __future__ import annotations

import hashlib
import json
import os
import posixpath
import shutil
import sqlite3
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S-%f")


def _hash(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _remote_mtime(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value or "")


class PortableSyncStore:
    def __init__(self, database_path: str, version_root: str):
        self.database_path = os.path.abspath(database_path)
        self.version_root = os.path.abspath(version_root)
        os.makedirs(os.path.dirname(self.database_path), exist_ok=True)
        os.makedirs(self.version_root, exist_ok=True)
        self._lock = threading.RLock()
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS sync_profiles (
                    id TEXT PRIMARY KEY, local_root TEXT NOT NULL, remote_root TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL, last_sync TEXT, last_result_json TEXT
                );
                CREATE TABLE IF NOT EXISTS sync_state (
                    profile_id TEXT NOT NULL, relative_path TEXT NOT NULL,
                    local_size INTEGER, local_mtime_ns INTEGER, local_sha256 TEXT,
                    remote_size INTEGER, remote_mtime TEXT,
                    updated_at TEXT NOT NULL, PRIMARY KEY(profile_id, relative_path)
                );
                CREATE TABLE IF NOT EXISTS sync_conflicts (
                    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, relative_path TEXT NOT NULL,
                    status TEXT NOT NULL, details_json TEXT NOT NULL,
                    created_at TEXT NOT NULL, resolved_at TEXT
                );
                """
            )

    def _connect(self):
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        return connection

    def create_profile(self, local_root: str, remote_root: str, enabled: bool = False) -> str:
        local_root = os.path.abspath(local_root)
        remote_root = "/" + remote_root.replace("\\", "/").strip("/")
        os.makedirs(local_root, exist_ok=True)
        profile_id = "sync_" + uuid.uuid4().hex
        now = _now()
        with self._lock, self._connect() as connection:
            connection.execute(
                "INSERT INTO sync_profiles VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)",
                (profile_id, local_root, remote_root, int(enabled), now, now),
            )
        return profile_id

    def get_profile(self, profile_id: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as connection:
            row = connection.execute("SELECT * FROM sync_profiles WHERE id=?", (profile_id,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["enabled"] = bool(result["enabled"])
        if result.get("last_result_json"):
            try:
                result["last_result"] = json.loads(result["last_result_json"])
            except json.JSONDecodeError:
                result["last_result"] = None
        result.pop("last_result_json", None)
        return result

    def list_profiles(self) -> list[dict[str, Any]]:
        with self._lock, self._connect() as connection:
            ids = [row[0] for row in connection.execute("SELECT id FROM sync_profiles ORDER BY created_at")]
        return [profile for profile_id in ids if (profile := self.get_profile(profile_id))]

    def set_enabled(self, profile_id: str, enabled: bool) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                "UPDATE sync_profiles SET enabled=?, updated_at=? WHERE id=?", (int(enabled), _now(), profile_id)
            )

    def get_state(self, profile_id: str) -> dict[str, dict[str, Any]]:
        with self._lock, self._connect() as connection:
            rows = connection.execute("SELECT * FROM sync_state WHERE profile_id=?", (profile_id,)).fetchall()
        return {row["relative_path"]: dict(row) for row in rows}

    def save_state(self, profile_id: str, relative_path: str, local: dict | None, remote: dict | None) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO sync_state VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(profile_id, relative_path) DO UPDATE SET
                    local_size=excluded.local_size, local_mtime_ns=excluded.local_mtime_ns,
                    local_sha256=excluded.local_sha256, remote_size=excluded.remote_size,
                    remote_mtime=excluded.remote_mtime, updated_at=excluded.updated_at
                """,
                (
                    profile_id, relative_path,
                    local.get("size") if local else None, local.get("mtime_ns") if local else None,
                    local.get("sha256") if local else None, remote.get("size") if remote else None,
                    remote.get("mtime") if remote else None, _now(),
                ),
            )

    def add_conflict(self, profile_id: str, relative_path: str, details: dict) -> str:
        conflict_id = "conflict_" + uuid.uuid4().hex
        with self._lock, self._connect() as connection:
            existing = connection.execute(
                "SELECT id FROM sync_conflicts WHERE profile_id=? AND relative_path=? AND status='open'",
                (profile_id, relative_path),
            ).fetchone()
            if existing:
                return str(existing[0])
            connection.execute(
                "INSERT INTO sync_conflicts VALUES (?, ?, ?, 'open', ?, ?, NULL)",
                (conflict_id, profile_id, relative_path, json.dumps(details, default=str), _now()),
            )
        return conflict_id

    def conflicts(self, profile_id: str | None = None) -> list[dict[str, Any]]:
        query, params = "SELECT * FROM sync_conflicts WHERE status='open'", []
        if profile_id:
            query += " AND profile_id=?"
            params.append(profile_id)
        query += " ORDER BY created_at DESC"
        with self._lock, self._connect() as connection:
            rows = connection.execute(query, params).fetchall()
        results = []
        for row in rows:
            item = dict(row)
            item["details"] = json.loads(item.pop("details_json"))
            results.append(item)
        return results

    def get_conflict(self, conflict_id: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as connection:
            row = connection.execute("SELECT * FROM sync_conflicts WHERE id=?", (conflict_id,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["details"] = json.loads(result.pop("details_json"))
        return result

    def resolve_conflict(self, conflict_id: str) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                "UPDATE sync_conflicts SET status='resolved', resolved_at=? WHERE id=?", (_now(), conflict_id)
            )

    def record_result(self, profile_id: str, result: dict) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                "UPDATE sync_profiles SET last_sync=?, last_result_json=?, updated_at=? WHERE id=?",
                (_now(), json.dumps(result, default=str), _now(), profile_id),
            )

    def version_path(self, profile_id: str, side: str, relative_path: str) -> str:
        relative = Path(relative_path.replace("\\", "/"))
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Unsafe sync relative path.")
        path = os.path.join(self.version_root, profile_id, _stamp(), side, *relative.parts)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        return path
