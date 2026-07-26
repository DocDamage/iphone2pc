from datetime import datetime

from fastapi.testclient import TestClient

import app as idrive
import app_diagnostics_router
from diagnostic_analytics import DiagnosticAnalytics


class BenchmarkAFC:
    def __init__(self, path, payload):
        self.path = path
        self.payload = payload
        self.offset = 0

    def stat(self, path):
        if path != self.path:
            raise FileNotFoundError(path)
        return {"st_ifmt": "S_IFREG", "st_size": len(self.payload), "st_mtime": datetime.now()}

    def exists(self, path):
        return path == self.path

    def fopen(self, path, mode="r"):
        assert path == self.path
        self.offset = 0
        return 1

    def fread(self, handle, size):
        payload = self.payload[self.offset:self.offset + size]
        self.offset += len(payload)
        return payload

    def fclose(self, handle):
        pass


class BenchmarkBridge:
    def __init__(self, path, payload):
        self.afc = BenchmarkAFC(path, payload)
        self.connected = True
        self.device_info = {"UniqueDeviceID": "test-device", "DeviceName": "Test iPhone"}

    def connect(self, force=False):
        return True, "connected"


def test_cable_benchmark_records_predictive_baseline(tmp_path, monkeypatch):
    source = "/iTunes_Control/iTunes/MediaLibrary.sqlitedb"
    bridge = BenchmarkBridge(source, b"benchmark" * 200_000)
    analytics = DiagnosticAnalytics(str(tmp_path / "diagnostics.sqlite3"))
    monkeypatch.setattr(idrive, "bridge", bridge)
    monkeypatch.setattr(app_diagnostics_router, "DIAGNOSTIC_ANALYTICS", analytics)
    monkeypatch.setattr(app_diagnostics_router.CONNECTION_TIMELINE, "record", lambda *args: True)

    response = TestClient(idrive.app).post(
        "/api/diagnostics/cable-benchmark", json={"max_bytes": 1024 * 1024}
    )

    assert response.status_code == 200
    assert response.json()["bytes_read"] == 1024 * 1024
    assert response.json()["predictive_health"]["samples"] == 1
    assert len(analytics.history()) == 1
