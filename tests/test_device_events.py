import ctypes
import os

from device_events import CMNotifyFilter, DeviceEventEngine, FilterUnion


def test_notify_filter_matches_windows_header_layout():
    if os.name == "nt":
        assert ctypes.sizeof(FilterUnion) == 400
        assert ctypes.sizeof(CMNotifyFilter) == 416


def test_event_engine_falls_back_and_emits_state_changes(monkeypatch):
    present = [False]
    events = []
    engine = DeviceEventEngine(lambda: present[0], events.append, poll_seconds=60)
    monkeypatch.setattr(engine, "_register_native", lambda: False)
    assert engine.start()["mode"] == "polling-fallback"
    assert events == ["removal"]
    present[0] = True
    engine._emit_from_probe()
    assert events == ["removal", "arrival"]
    assert engine.stop()["running"] is False
