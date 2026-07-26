"""Historical cable/port measurements and predictive health scoring."""

from __future__ import annotations

import json
import os
import sqlite3
import statistics
import threading
from datetime import datetime, timezone


class DiagnosticAnalytics:
    def __init__(self, database_path: str):
        self.database_path = os.path.abspath(database_path)
        os.makedirs(os.path.dirname(self.database_path), exist_ok=True)
        self._lock = threading.RLock()
        with self._connect() as connection:
            connection.execute(
                """CREATE TABLE IF NOT EXISTS cable_samples(
                id INTEGER PRIMARY KEY AUTOINCREMENT, captured_at TEXT NOT NULL, device_key TEXT,
                port_key TEXT, throughput REAL NOT NULL, median_ms REAL NOT NULL,
                maximum_stall_ms REAL NOT NULL, jitter_ms REAL NOT NULL, health TEXT, raw_json TEXT NOT NULL)"""
            )

    def _connect(self):
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        return connection

    def record(self, sample: dict, device_key: str | None = None, port_key: str | None = None) -> int:
        throughput = float(sample.get("throughput_mbps", sample.get("mib_per_second", 0)) or 0)
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                """INSERT INTO cable_samples(captured_at,device_key,port_key,throughput,median_ms,maximum_stall_ms,jitter_ms,health,raw_json)
                VALUES(?,?,?,?,?,?,?,?,?)""",
                (datetime.now(timezone.utc).isoformat(), device_key, port_key, throughput,
                 float(sample.get("median_chunk_ms", 0) or 0), float(sample.get("maximum_stall_ms", 0) or 0),
                 float(sample.get("jitter_ms", 0) or 0), sample.get("health"), json.dumps(sample, default=str)),
            )
            return int(cursor.lastrowid)

    def history(self, device_key: str | None = None, limit: int = 100) -> list[dict]:
        query, params = "SELECT * FROM cable_samples", []
        if device_key:
            query += " WHERE device_key=?"
            params.append(device_key)
        query += " ORDER BY id DESC LIMIT ?"
        params.append(max(1, min(int(limit), 5000)))
        with self._lock, self._connect() as connection:
            return [dict(row) for row in connection.execute(query, params)]

    def prediction(self, device_key: str | None = None) -> dict:
        rows = list(reversed(self.history(device_key, 100)))
        if not rows:
            return {"state": "unknown", "score": None, "samples": 0, "recommendation": "Run a cable benchmark."}
        speeds = [row["throughput"] for row in rows]
        stalls = [row["maximum_stall_ms"] for row in rows]
        jitter = [row["jitter_ms"] for row in rows]
        x_mean = (len(rows) - 1) / 2
        denominator = sum((index - x_mean) ** 2 for index in range(len(rows)))
        slope = sum((index - x_mean) * (speed - statistics.mean(speeds)) for index, speed in enumerate(speeds)) / denominator if denominator else 0
        speed_score = min(45, statistics.median(speeds) / 20 * 45)
        stall_score = max(0, 30 - statistics.median(stalls) / 1000 * 15)
        jitter_score = max(0, 20 - statistics.median(jitter) / 250 * 10)
        trend_score = 5 if slope >= -0.5 else max(0, 5 + slope)
        score = round(max(0, min(100, speed_score + stall_score + jitter_score + trend_score)))
        state = "excellent" if score >= 85 else "good" if score >= 65 else "unstable" if score >= 40 else "critical"
        if slope < -1:
            recommendation = "Throughput is declining; retest with another cable and a direct motherboard port."
        elif statistics.median(stalls) > 2000:
            recommendation = "Long stalls detected; avoid hubs and check Apple Mobile Device service health."
        elif score < 65:
            recommendation = "Use a different data-rated cable or USB port before a large recovery."
        else:
            recommendation = "Connection history is suitable for recovery."
        return {"state": state, "score": score, "samples": len(rows), "throughput_median": round(statistics.median(speeds), 2),
                "maximum_stall_median": round(statistics.median(stalls), 2), "throughput_slope": round(slope, 3),
                "recommendation": recommendation}
