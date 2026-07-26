"""Local Beat DNA search and relationship graph over catalog analysis."""

from __future__ import annotations

import json
import math
import re
import sqlite3
from pathlib import Path
from typing import Any


MOODS = {
    "dark": {"mode": "minor", "bpm": 130, "loudness": -14},
    "sad": {"mode": "minor", "bpm": 90, "loudness": -18},
    "chill": {"bpm": 85, "loudness": -20},
    "energetic": {"bpm": 145, "loudness": -10},
    "aggressive": {"bpm": 155, "loudness": -8},
    "upbeat": {"mode": "major", "bpm": 125, "loudness": -12},
}


def _decode(value: str | None, default):
    try:
        return json.loads(value or "")
    except (json.JSONDecodeError, TypeError):
        return default


def _vector(analysis: dict[str, Any]) -> list[float]:
    bpm = float(analysis.get("bpm") or 0) / 200
    loudness = (float(analysis.get("loudness") or -60) + 60) / 60
    duration = min(1.0, math.log1p(float(analysis.get("duration") or 0)) / math.log1p(900))
    key = str(analysis.get("key") or "")
    mode = 1.0 if "major" in key else -1.0 if "minor" in key else 0.0
    waveform = [float(value) for value in analysis.get("waveform") or []]
    windows = []
    for index in range(8):
        sample = waveform[index::8]
        windows.append(sum(sample) / len(sample) if sample else 0.0)
    return [bpm, loudness, duration, mode, *windows]


def _cosine(left: list[float], right: list[float]) -> float:
    numerator = sum(a * b for a, b in zip(left, right))
    denominator = math.sqrt(sum(a * a for a in left) * sum(b * b for b in right))
    return numerator / denominator if denominator else 0.0


def _project_stem(track: dict) -> str:
    text = Path(str(track.get("title") or track.get("original_filename") or "")).stem.casefold()
    text = re.sub(r"\b(v\d+|version|mix|master|instrumental|inst|demo|final|bounce|edit)\b", "", text)
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


class BeatGraph:
    def __init__(self, catalog_database: str):
        self.database_path = str(catalog_database)

    def _records(self) -> list[dict]:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        try:
            rows = connection.execute(
                """SELECT t.id,t.title,t.artist,t.album,t.original_filename,t.iphone_path,t.raw_json,
                a.analysis_json,a.content_sha256,a.acoustic_fingerprint FROM tracks t
                LEFT JOIN analysis a ON a.track_id=t.id ORDER BY t.title COLLATE NOCASE"""
            ).fetchall()
        finally:
            connection.close()
        records = []
        for row in rows:
            track = _decode(row["raw_json"], {})
            track.update({key: row[key] for key in ("id", "title", "artist", "album", "original_filename", "iphone_path")})
            track["analysis"] = _decode(row["analysis_json"], {})
            track["content_sha256"] = row["content_sha256"]
            track["acoustic_fingerprint"] = row["acoustic_fingerprint"]
            records.append(track)
        return records

    def semantic_search(self, query: str, limit: int = 50) -> list[dict]:
        query = str(query or "").casefold().strip()
        tokens = set(re.findall(r"[a-z0-9♯#]+", query))
        bpm_match = re.search(r"\b(\d{2,3})\s*(?:bpm)?\b", query)
        target_bpm = float(bpm_match.group(1)) if bpm_match else None
        requested = next((value for mood, value in MOODS.items() if mood in tokens), {})
        target_bpm = target_bpm or requested.get("bpm")
        results = []
        for track in self._records():
            analysis = track["analysis"]
            haystack = " ".join(str(track.get(key) or "") for key in ("title", "artist", "album", "original_filename")).casefold()
            score, reasons = 0.0, []
            matches = [token for token in tokens if token in haystack]
            if matches:
                score += min(0.65, 0.2 * len(matches))
                reasons.append("metadata match")
            bpm = analysis.get("bpm")
            if target_bpm and bpm:
                closeness = max(0.0, 1 - abs(float(bpm) - target_bpm) / 40)
                score += 0.35 * closeness
                if closeness > 0.8:
                    reasons.append("tempo match")
            mode = requested.get("mode")
            if mode and mode in str(analysis.get("key") or "").casefold():
                score += 0.2
                reasons.append(f"{mode} key")
            target_loudness = requested.get("loudness")
            if target_loudness is not None and analysis.get("loudness") is not None:
                score += 0.15 * max(0.0, 1 - abs(float(analysis["loudness"]) - target_loudness) / 20)
            if not query:
                score = 1.0
            if score > 0:
                results.append({"track": track, "score": round(min(score, 1.0), 4), "reasons": reasons})
        return sorted(results, key=lambda item: (-item["score"], str(item["track"].get("title") or "").casefold()))[:limit]

    def similar(self, track_id: str, limit: int = 20) -> list[dict]:
        records = self._records()
        source = next((item for item in records if item["id"] == track_id), None)
        if not source or not source["analysis"]:
            return []
        source_vector = _vector(source["analysis"])
        results = []
        for track in records:
            if track["id"] == track_id or not track["analysis"]:
                continue
            score = _cosine(source_vector, _vector(track["analysis"]))
            results.append({"track": track, "score": round(score, 4)})
        return sorted(results, key=lambda item: -item["score"])[:limit]

    def graph(self, similarity_threshold: float = 0.92) -> dict:
        records = self._records()
        nodes = [{"id": item["id"], "title": item.get("title"), "artist": item.get("artist"),
                  "analyzed": bool(item["analysis"])} for item in records]
        edges = []
        for index, left in enumerate(records):
            for right in records[index + 1:]:
                kind, score = None, 0.0
                if left.get("content_sha256") and left["content_sha256"] == right.get("content_sha256"):
                    kind, score = "exact-copy", 1.0
                elif left.get("acoustic_fingerprint") and left["acoustic_fingerprint"] == right.get("acoustic_fingerprint"):
                    kind, score = "acoustic-version", 0.99
                elif left["analysis"] and right["analysis"]:
                    score = _cosine(_vector(left["analysis"]), _vector(right["analysis"]))
                    if score >= similarity_threshold:
                        kind = "similar-sound"
                if not kind and _project_stem(left) and _project_stem(left) == _project_stem(right):
                    kind, score = "project-family", 0.9
                if kind:
                    edges.append({"source": left["id"], "target": right["id"], "kind": kind, "score": round(score, 4)})
        return {"nodes": nodes, "edges": edges, "analyzed": sum(node["analyzed"] for node in nodes)}
