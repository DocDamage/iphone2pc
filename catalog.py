"""Persistent, searchable media catalog."""

from __future__ import annotations

import json
import os
import posixpath
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any, Iterable

from media_library_decoder import HASHED_NAME, _duration_text, _track_id, decode_media_library

class MediaCatalog:
    """Thread-safe, durable catalog for discovered tracks and analysis results."""

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
                CREATE TABLE IF NOT EXISTS tracks (
                    id TEXT PRIMARY KEY,
                    iphone_path TEXT NOT NULL UNIQUE,
                    title TEXT,
                    artist TEXT,
                    album TEXT,
                    album_artist TEXT,
                    original_filename TEXT,
                    extension TEXT,
                    size_bytes INTEGER NOT NULL DEFAULT 0,
                    duration REAL NOT NULL DEFAULT 0,
                    modified TEXT,
                    metadata_pending INTEGER NOT NULL DEFAULT 1,
                    decoded INTEGER NOT NULL DEFAULT 0,
                    bpm REAL,
                    year INTEGER,
                    date_added TEXT,
                    playlists_json TEXT NOT NULL DEFAULT '[]',
                    raw_json TEXT NOT NULL,
                    last_seen TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_tracks_path ON tracks(iphone_path);
                CREATE INDEX IF NOT EXISTS idx_tracks_extension ON tracks(extension);
                CREATE TABLE IF NOT EXISTS analysis (
                    track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
                    content_sha256 TEXT,
                    acoustic_fingerprint TEXT,
                    duration REAL,
                    bpm REAL,
                    musical_key TEXT,
                    loudness REAL,
                    sample_rate INTEGER,
                    channels INTEGER,
                    waveform_json TEXT NOT NULL DEFAULT '[]',
                    analysis_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_analysis_sha ON analysis(content_sha256);
                CREATE INDEX IF NOT EXISTS idx_analysis_fp ON analysis(acoustic_fingerprint);
                """
            )

    @staticmethod
    def _normalize(track: dict[str, Any]) -> dict[str, Any]:
        path = str(track.get("iphone_path") or "/unknown").replace("\\", "/")
        original = str(track.get("original_filename") or posixpath.basename(path))
        extension = str(track.get("extension") or os.path.splitext(original)[1]).lower()
        normalized = dict(track)
        normalized.update(
            {
                "id": str(track.get("id") or _track_id(path)),
                "iphone_path": path,
                "title": str(track.get("title") or os.path.splitext(original)[0]),
                "artist": str(track.get("artist") or "Unknown Artist"),
                "album": str(track.get("album") or "Unknown Album / Original Beats"),
                "album_artist": str(track.get("album_artist") or track.get("artist") or "Unknown Artist"),
                "original_filename": original,
                "extension": extension,
                "size_bytes": int(track.get("size_bytes", track.get("filesize", 0)) or 0),
                "duration": float(track.get("duration", 0) or 0),
                "metadata_pending": bool(track.get("metadata_pending", True)),
                "decoded": bool(track.get("decoded", False)),
                "playlists": list(track.get("playlists") or []),
            }
        )
        return normalized

    def upsert_tracks(self, tracks: Iterable[dict[str, Any]]) -> int:
        normalized = [self._normalize(track) for track in tracks]
        if not normalized:
            return 0
        now = datetime.now(timezone.utc).isoformat()
        statement = """
            INSERT INTO tracks (
                id, iphone_path, title, artist, album, album_artist, original_filename,
                extension, size_bytes, duration, modified, metadata_pending, decoded,
                bpm, year, date_added, playlists_json, raw_json, last_seen
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                iphone_path=excluded.iphone_path, title=excluded.title, artist=excluded.artist,
                album=excluded.album, album_artist=excluded.album_artist,
                original_filename=excluded.original_filename, extension=excluded.extension,
                size_bytes=excluded.size_bytes, duration=excluded.duration,
                modified=COALESCE(excluded.modified, tracks.modified),
                metadata_pending=excluded.metadata_pending, decoded=excluded.decoded,
                bpm=COALESCE(excluded.bpm, tracks.bpm), year=COALESCE(excluded.year, tracks.year),
                date_added=COALESCE(excluded.date_added, tracks.date_added),
                playlists_json=excluded.playlists_json, raw_json=excluded.raw_json,
                last_seen=excluded.last_seen
        """
        values = [
            (
                item["id"], item["iphone_path"], item["title"], item["artist"], item["album"],
                item["album_artist"], item["original_filename"], item["extension"], item["size_bytes"],
                item["duration"], item.get("modified"), int(item["metadata_pending"]), int(item["decoded"]),
                item.get("bpm"), item.get("year"), item.get("date_added"),
                json.dumps(item["playlists"], ensure_ascii=False), json.dumps(item, ensure_ascii=False, default=str), now,
            )
            for item in normalized
        ]
        with self._lock, self._connect() as connection:
            connection.executemany(statement, values)
        return len(normalized)

    @staticmethod
    def _decode_row(row: sqlite3.Row) -> dict[str, Any]:
        try:
            result = json.loads(row["raw_json"] or "{}")
        except json.JSONDecodeError:
            result = {}
        for key in row.keys():
            if key not in {"raw_json", "playlists_json"} and row[key] is not None:
                result[key] = row[key]
        result["metadata_pending"] = bool(result.get("metadata_pending"))
        result["decoded"] = bool(result.get("decoded"))
        try:
            result["playlists"] = json.loads(row["playlists_json"] or "[]")
        except json.JSONDecodeError:
            result["playlists"] = []
        size_bytes = int(result.get("size_bytes", 0) or 0)
        duration = float(result.get("duration", 0) or 0)
        result["filesize"] = round(size_bytes / (1024 * 1024), 2)
        result["duration_str"] = _duration_text(duration) if duration else "--"
        result.setdefault("bitrate", "—")
        return result

    def query_tracks(
        self,
        search: str | None = None,
        extension: str | None = None,
        mystery_only: bool = False,
        date_from: str | None = None,
        date_to: str | None = None,
        min_duration: float | None = None,
        max_duration: float | None = None,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if search:
            clauses.append("(title LIKE ? OR artist LIKE ? OR album LIKE ? OR iphone_path LIKE ?)")
            term = f"%{search}%"
            params.extend([term, term, term, term])
        if extension:
            normalized_extension = extension.lower()
            if not normalized_extension.startswith("."):
                normalized_extension = f".{normalized_extension}"
            clauses.append("extension = ?")
            params.append(normalized_extension)
        if date_from:
            clauses.append("COALESCE(date_added, modified, '') >= ?")
            params.append(date_from)
        if date_to:
            clauses.append("COALESCE(date_added, modified, '') <= ?")
            params.append(date_to)
        if min_duration is not None:
            clauses.append("duration >= ?")
            params.append(float(min_duration))
        if max_duration is not None:
            clauses.append("duration <= ?")
            params.append(float(max_duration))
        sql = "SELECT * FROM tracks"
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY COALESCE(date_added, modified, last_seen) DESC, title COLLATE NOCASE"
        with self._lock, self._connect() as connection:
            tracks = [self._decode_row(row) for row in connection.execute(sql, params)]
        if mystery_only:
            tracks = [
                track
                for track in tracks
                if track.get("metadata_pending")
                or bool(HASHED_NAME.fullmatch(os.path.splitext(str(track.get("title", "")))[0]))
            ]
        return tracks

    def get_track(self, track_id: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as connection:
            row = connection.execute("SELECT * FROM tracks WHERE id=?", (track_id,)).fetchone()
        return self._decode_row(row) if row else None

    def get_by_path(self, iphone_path: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as connection:
            row = connection.execute("SELECT * FROM tracks WHERE iphone_path=?", (iphone_path,)).fetchone()
        return self._decode_row(row) if row else None

    def save_analysis(self, track_id: str, analysis: dict[str, Any]) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO analysis (
                    track_id, content_sha256, acoustic_fingerprint, duration, bpm, musical_key,
                    loudness, sample_rate, channels, waveform_json, analysis_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(track_id) DO UPDATE SET
                    content_sha256=excluded.content_sha256,
                    acoustic_fingerprint=excluded.acoustic_fingerprint,
                    duration=excluded.duration, bpm=excluded.bpm, musical_key=excluded.musical_key,
                    loudness=excluded.loudness, sample_rate=excluded.sample_rate,
                    channels=excluded.channels, waveform_json=excluded.waveform_json,
                    analysis_json=excluded.analysis_json, updated_at=excluded.updated_at
                """,
                (
                    track_id, analysis.get("content_sha256"), analysis.get("acoustic_fingerprint"),
                    analysis.get("duration"), analysis.get("bpm"), analysis.get("key"),
                    analysis.get("loudness"), analysis.get("sample_rate"), analysis.get("channels"),
                    json.dumps(analysis.get("waveform") or []), json.dumps(analysis, default=str), now,
                ),
            )
            connection.execute(
                "UPDATE tracks SET duration=COALESCE(?, duration), bpm=COALESCE(?, bpm), last_seen=? WHERE id=?",
                (analysis.get("duration"), analysis.get("bpm"), now, track_id),
            )

    def get_analysis(self, track_id: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as connection:
            row = connection.execute("SELECT analysis_json, updated_at FROM analysis WHERE track_id=?", (track_id,)).fetchone()
        if not row:
            return None
        try:
            result = json.loads(row["analysis_json"] or "{}")
        except json.JSONDecodeError:
            result = {}
        result["updated_at"] = row["updated_at"]
        return result

    def version_groups(self) -> list[dict[str, Any]]:
        groups: list[dict[str, Any]] = []
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT COALESCE(NULLIF(content_sha256, ''), NULLIF(acoustic_fingerprint, '')) AS value,
                       CASE WHEN NULLIF(content_sha256, '') IS NOT NULL THEN 'content_sha256'
                            ELSE 'acoustic_fingerprint' END AS kind,
                       COUNT(*) AS total
                  FROM analysis
                 WHERE NULLIF(content_sha256, '') IS NOT NULL OR NULLIF(acoustic_fingerprint, '') IS NOT NULL
                 GROUP BY value
                HAVING COUNT(*) > 1
                 ORDER BY total DESC
                """
            ).fetchall()
            for row in rows:
                track_rows = connection.execute(
                    """
                    SELECT t.* FROM tracks t JOIN analysis a ON a.track_id=t.id
                     WHERE COALESCE(NULLIF(a.content_sha256, ''), NULLIF(a.acoustic_fingerprint, ''))=?
                     ORDER BY t.title COLLATE NOCASE
                    """,
                    (row["value"],),
                ).fetchall()
                groups.append(
                    {
                        "kind": row["kind"],
                        "value": row["value"],
                        "tracks": [self._decode_row(track_row) for track_row in track_rows],
                    }
                )
        return groups
