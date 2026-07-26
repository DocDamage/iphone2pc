"""Durable recovery queue, reports, and encrypted rescue vaults."""

from __future__ import annotations

import csv
import hashlib
import html
import json
import os
import sqlite3
import struct
import tempfile
import threading
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt


VAULT_MAGIC = b"IDRPV1\r\n"
STREAM_CHUNK = 1024 * 1024


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class QueueStore:
    """SQLite-backed queue that survives app and PC restarts."""

    def __init__(self, database_path: str):
        self.database_path = os.path.abspath(database_path)
        os.makedirs(os.path.dirname(self.database_path), exist_ok=True)
        self._lock = threading.RLock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _initialize(self) -> None:
        with self._lock, self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS recovery_jobs (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    output_dir TEXT NOT NULL,
                    backup_dir TEXT,
                    structure_mode TEXT NOT NULL DEFAULT 'flat',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    report_json TEXT
                );
                CREATE TABLE IF NOT EXISTS recovery_items (
                    id TEXT PRIMARY KEY,
                    job_id TEXT NOT NULL REFERENCES recovery_jobs(id) ON DELETE CASCADE,
                    track_id TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    track_json TEXT NOT NULL,
                    title TEXT,
                    expected_bytes INTEGER NOT NULL DEFAULT 0,
                    bytes INTEGER NOT NULL DEFAULT 0,
                    primary_path TEXT,
                    backup_path TEXT,
                    sha256 TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_queue_status ON recovery_items(status, position);
                CREATE INDEX IF NOT EXISTS idx_queue_job ON recovery_items(job_id, position);
                """
            )
            # A terminated process may leave a claim in-flight. Resume it safely from
            # the partial transfer on the next worker start.
            connection.execute("UPDATE recovery_items SET status='interrupted' WHERE status='running'")
            connection.execute("UPDATE recovery_jobs SET status='queued' WHERE status='running'")

    def create_job(
        self,
        tracks: Iterable[dict[str, Any]],
        output_dir: str,
        backup_dir: str | None = None,
        structure_mode: str = "flat",
    ) -> str:
        if structure_mode not in {"flat", "artist", "album"}:
            raise ValueError("Invalid recovery folder structure.")
        items = [dict(track) for track in tracks]
        if not items:
            raise ValueError("At least one track is required.")
        job_id = "job_" + uuid.uuid4().hex
        now = _now()
        with self._lock, self._connect() as connection:
            connection.execute(
                "INSERT INTO recovery_jobs VALUES (?, 'queued', ?, ?, ?, ?, ?, NULL)",
                (job_id, os.path.abspath(output_dir), os.path.abspath(backup_dir) if backup_dir else None, structure_mode, now, now),
            )
            for position, track in enumerate(items):
                item_id = "item_" + uuid.uuid4().hex
                connection.execute(
                    """
                    INSERT INTO recovery_items (
                        id, job_id, track_id, position, status, track_json, title,
                        expected_bytes, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
                    """,
                    (
                        item_id, job_id, str(track.get("id")), position,
                        json.dumps(track, ensure_ascii=False, default=str),
                        str(track.get("title") or track.get("original_filename") or "Unknown track"),
                        int(track.get("size_bytes", track.get("filesize", 0)) or 0), now, now,
                    ),
                )
        return job_id

    @staticmethod
    def _item(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        try:
            result["track"] = json.loads(result.pop("track_json"))
        except (json.JSONDecodeError, TypeError):
            result["track"] = {}
            result.pop("track_json", None)
        return result

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as connection:
            job = connection.execute("SELECT * FROM recovery_jobs WHERE id=?", (job_id,)).fetchone()
            if not job:
                return None
            items = connection.execute(
                "SELECT * FROM recovery_items WHERE job_id=? ORDER BY position, created_at", (job_id,)
            ).fetchall()
        result = dict(job)
        result["items"] = [self._item(item) for item in items]
        result["total_bytes"] = sum(item["expected_bytes"] for item in result["items"])
        result["completed_bytes"] = sum(item["bytes"] for item in result["items"] if item["status"] == "complete")
        result["progress"] = round(100 * result["completed_bytes"] / result["total_bytes"], 1) if result["total_bytes"] else 0
        if result.get("report_json"):
            try:
                result["report"] = json.loads(result["report_json"])
            except json.JSONDecodeError:
                result["report"] = None
        result.pop("report_json", None)
        return result

    def list_jobs(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock, self._connect() as connection:
            ids = [row[0] for row in connection.execute(
                "SELECT id FROM recovery_jobs ORDER BY created_at DESC LIMIT ?", (max(1, min(limit, 500)),)
            )]
        return [job for job_id in ids if (job := self.get_job(job_id))]

    def claim_next(self) -> dict[str, Any] | None:
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT i.* FROM recovery_items i
                JOIN recovery_jobs j ON j.id=i.job_id
                WHERE j.status IN ('queued', 'running')
                  AND i.status IN ('queued', 'interrupted')
                ORDER BY j.created_at, i.position LIMIT 1
                """
            ).fetchone()
            if not row:
                return None
            now = _now()
            connection.execute(
                "UPDATE recovery_items SET status='running', attempts=attempts+1, error=NULL, updated_at=? WHERE id=?",
                (now, row["id"]),
            )
            connection.execute(
                "UPDATE recovery_jobs SET status='running', updated_at=? WHERE id=?", (now, row["job_id"])
            )
            claimed = connection.execute("SELECT * FROM recovery_items WHERE id=?", (row["id"],)).fetchone()
        return self._item(claimed)

    def update_item(self, item_id: str, **changes: Any) -> None:
        allowed = {"status", "bytes", "primary_path", "backup_path", "sha256", "error", "title"}
        updates = {key: value for key, value in changes.items() if key in allowed}
        if not updates:
            return
        updates["updated_at"] = _now()
        sql = "UPDATE recovery_items SET " + ", ".join(f"{key}=?" for key in updates) + " WHERE id=?"
        with self._lock, self._connect() as connection:
            connection.execute(sql, (*updates.values(), item_id))
            row = connection.execute("SELECT job_id FROM recovery_items WHERE id=?", (item_id,)).fetchone()
            if row:
                connection.execute("UPDATE recovery_jobs SET updated_at=? WHERE id=?", (_now(), row[0]))

    def pause_job(self, job_id: str) -> None:
        self._set_job_status(job_id, "paused")

    def resume_job(self, job_id: str) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                "UPDATE recovery_items SET status='queued', updated_at=? WHERE job_id=? AND status='interrupted'",
                (_now(), job_id),
            )
            connection.execute("UPDATE recovery_jobs SET status='queued', updated_at=? WHERE id=?", (_now(), job_id))

    def _set_job_status(self, job_id: str, status: str) -> None:
        with self._lock, self._connect() as connection:
            connection.execute("UPDATE recovery_jobs SET status=?, updated_at=? WHERE id=?", (status, _now(), job_id))

    def retry_failed(self, job_id: str) -> int:
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE recovery_items SET status='queued', error=NULL, updated_at=?
                 WHERE job_id=? AND status IN ('failed', 'interrupted')
                """,
                (_now(), job_id),
            )
            connection.execute("UPDATE recovery_jobs SET status='queued', updated_at=? WHERE id=?", (_now(), job_id))
            return cursor.rowcount

    def reorder(self, job_id: str, track_ids: list[str]) -> None:
        with self._lock, self._connect() as connection:
            existing = connection.execute(
                "SELECT id, track_id FROM recovery_items WHERE job_id=? ORDER BY position", (job_id,)
            ).fetchall()
            by_track: dict[str, list[str]] = {}
            for row in existing:
                by_track.setdefault(row["track_id"], []).append(row["id"])
            ordered_ids: list[str] = []
            for track_id in track_ids:
                if by_track.get(track_id):
                    ordered_ids.append(by_track[track_id].pop(0))
            for row in existing:
                if row["id"] not in ordered_ids:
                    ordered_ids.append(row["id"])
            for position, item_id in enumerate(ordered_ids):
                connection.execute(
                    "UPDATE recovery_items SET position=?, updated_at=? WHERE id=?", (position, _now(), item_id)
                )

    def finish_ready_jobs(self) -> list[str]:
        finished: list[str] = []
        with self._lock, self._connect() as connection:
            jobs = connection.execute(
                "SELECT id FROM recovery_jobs WHERE status IN ('queued', 'running')"
            ).fetchall()
            for row in jobs:
                statuses = [item[0] for item in connection.execute(
                    "SELECT status FROM recovery_items WHERE job_id=?", (row["id"],)
                )]
                if statuses and not any(status in {"queued", "running", "interrupted"} for status in statuses):
                    status = "completed" if all(value == "complete" for value in statuses) else "completed_with_errors"
                    connection.execute(
                        "UPDATE recovery_jobs SET status=?, updated_at=? WHERE id=?", (status, _now(), row["id"])
                    )
                    finished.append(row["id"])
        return finished

    def save_report(self, job_id: str, report: dict[str, Any]) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                "UPDATE recovery_jobs SET report_json=?, updated_at=? WHERE id=?",
                (json.dumps(report, ensure_ascii=False), _now(), job_id),
            )
