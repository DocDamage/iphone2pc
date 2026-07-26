"""Persistent media catalog and Apple MediaLibrary decoder for iDrivePulse."""

from __future__ import annotations

import hashlib
import json
import os
import posixpath
import re
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable


APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)
HASHED_NAME = re.compile(r"^[A-Z0-9]{4,8}$", re.IGNORECASE)


def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
    if table not in {
        "item",
        "item_extra",
        "item_artist",
        "album",
        "album_artist",
        "base_location",
        "container",
        "container_item",
    }:
        return set()
    return {str(row[1]) for row in connection.execute(f'PRAGMA table_info("{table}")')}


def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row is not None


def _select(column: str, available: set[str], alias: str, default: str = "NULL") -> str:
    return f'{alias}."{column}"' if column in available else default


def _iphone_path(base: Any, location: Any) -> str:
    base_text = str(base or "").replace("\\", "/").strip("/")
    location_text = str(location or "").replace("\\", "/").strip("/")
    combined = posixpath.normpath(posixpath.join("/", base_text, location_text))
    return combined if combined.startswith("/") else f"/{combined}"


def _track_id(path: str) -> str:
    return "tr_" + hashlib.sha256(path.encode("utf-8", errors="replace")).hexdigest()[:16]


def _duration_text(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    return f"{total // 60}:{total % 60:02d}"


def _date_text(value: Any) -> str | None:
    if value in (None, ""):
        return None
    try:
        numeric = float(value)
        # Apple media databases use the 2001 epoch. Unix values are retained too.
        stamp = APPLE_EPOCH + timedelta(seconds=numeric) if numeric < 1_200_000_000 else datetime.fromtimestamp(numeric, timezone.utc)
        return stamp.astimezone().strftime("%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError, OverflowError, OSError):
        return str(value)


def _safe_filename(title: str, extension: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", title).strip(" .") or "Recovered Track"
    return f"{name[:180]}{extension}"


def decode_media_library(database_path: str) -> list[dict[str, Any]]:
    """Decode Apple's MediaLibrary.sqlitedb without changing the source database."""
    uri = Path(database_path).resolve().as_uri() + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    try:
        required = {"item", "item_extra", "base_location"}
        if not all(_table_exists(connection, table) for table in required):
            raise ValueError("This database does not contain the expected Apple media-library tables.")

        item_cols = _columns(connection, "item")
        extra_cols = _columns(connection, "item_extra")
        artist_cols = _columns(connection, "item_artist")
        album_cols = _columns(connection, "album")
        album_artist_cols = _columns(connection, "album_artist")
        base_cols = _columns(connection, "base_location")

        joins = [
            "JOIN item_extra e ON e.item_pid = i.item_pid",
            "JOIN base_location b ON b.base_location_id = i.base_location_id",
        ]
        artist_expression = "NULL"
        if {"item_artist_pid", "item_artist"}.issubset(artist_cols) and "item_artist_pid" in item_cols:
            joins.append("LEFT JOIN item_artist ar ON ar.item_artist_pid = i.item_artist_pid")
            artist_expression = 'ar."item_artist"'
        album_expression = "NULL"
        if {"album_pid", "album"}.issubset(album_cols) and "album_pid" in item_cols:
            joins.append("LEFT JOIN album al ON al.album_pid = i.album_pid")
            album_expression = 'al."album"'
        album_artist_expression = "NULL"
        if (
            {"album_artist_pid", "album_artist"}.issubset(album_artist_cols)
            and "album_artist_pid" in album_cols
            and album_expression != "NULL"
        ):
            joins.append("LEFT JOIN album_artist aa ON aa.album_artist_pid = al.album_artist_pid")
            album_artist_expression = 'aa."album_artist"'

        date_added = _select("date_added", item_cols, "i", _select("date_added", extra_cols, "e"))
        query = f"""
            SELECT i.item_pid AS item_pid,
                   {_select('title', extra_cols, 'e')} AS title,
                   {artist_expression} AS artist,
                   {album_expression} AS album,
                   {album_artist_expression} AS album_artist,
                   {_select('path', base_cols, 'b')} AS base_path,
                   {_select('location', extra_cols, 'e')} AS location,
                   {_select('file_size', extra_cols, 'e', '0')} AS file_size,
                   {_select('total_time_ms', extra_cols, 'e', '0')} AS total_time_ms,
                   {_select('filetype', extra_cols, 'e')} AS filetype,
                   {_select('date_modified', extra_cols, 'e')} AS date_modified,
                   {date_added} AS date_added,
                   {_select('bpm', extra_cols, 'e')} AS bpm,
                   {_select('year', extra_cols, 'e')} AS year
              FROM item i
              {' '.join(joins)}
             WHERE COALESCE({_select('location', extra_cols, 'e', "''")}, '') <> ''
               AND COALESCE({_select('path', base_cols, 'b', "''")}, '') <> ''
        """
        rows = list(connection.execute(query))

        playlist_map: dict[Any, list[str]] = {}
        if _table_exists(connection, "container") and _table_exists(connection, "container_item"):
            container_cols = _columns(connection, "container")
            container_item_cols = _columns(connection, "container_item")
            if {"container_pid", "name"}.issubset(container_cols) and {
                "container_pid",
                "item_pid",
            }.issubset(container_item_cols):
                for item_pid, name in connection.execute(
                    "SELECT ci.item_pid, c.name FROM container_item ci "
                    "JOIN container c ON c.container_pid = ci.container_pid "
                    "WHERE COALESCE(c.name, '') <> '' ORDER BY c.name"
                ):
                    playlist_map.setdefault(item_pid, []).append(str(name))

        decoded: list[dict[str, Any]] = []
        for row in rows:
            path = _iphone_path(row["base_path"], row["location"])
            original = posixpath.basename(path)
            extension = os.path.splitext(original)[1].lower()
            title = str(row["title"] or os.path.splitext(original)[0])
            duration = max(0.0, float(row["total_time_ms"] or 0) / 1000.0)
            decoded.append(
                {
                    "id": _track_id(path),
                    "item_pid": row["item_pid"],
                    "iphone_path": path,
                    "title": title,
                    "artist": str(row["artist"] or "Unknown Artist"),
                    "album": str(row["album"] or "Unknown Album / Original Beats"),
                    "album_artist": str(row["album_artist"] or row["artist"] or "Unknown Artist"),
                    "original_filename": original,
                    "clean_filename": _safe_filename(title, extension),
                    "extension": extension or (f".{row['filetype']}" if row["filetype"] else ""),
                    "size_bytes": int(row["file_size"] or 0),
                    "filesize": int(row["file_size"] or 0),
                    "duration": duration,
                    "duration_str": _duration_text(duration),
                    "modified": _date_text(row["date_modified"]),
                    "date_added": _date_text(row["date_added"]),
                    "bpm": float(row["bpm"]) if row["bpm"] not in (None, "") else None,
                    "year": int(row["year"]) if row["year"] not in (None, "") else None,
                    "playlists": playlist_map.get(row["item_pid"], []),
                    "metadata_pending": False,
                    "decoded": True,
                    "has_artwork": False,
                    "bitrate": "—",
                }
            )
        return decoded
    finally:
        connection.close()
