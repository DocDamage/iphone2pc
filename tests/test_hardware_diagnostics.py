from hardware_diagnostics import ConnectionTimeline, benchmark_afc


class BenchmarkAFC:
    def __init__(self, payload):
        self.payload = payload
        self.offset = 0

    def stat(self, path):
        return {"st_size": len(self.payload)}

    def fopen(self, path, mode):
        self.offset = 0
        return 1

    def fread(self, handle, size):
        chunk = self.payload[self.offset:self.offset + size]
        self.offset += len(chunk)
        return chunk

    def fclose(self, handle):
        return None


def test_afc_benchmark_is_read_only_and_reports_throughput():
    result = benchmark_afc(BenchmarkAFC(b"x" * 200_000), "/sample.bin", max_bytes=100_000)

    assert result["bytes_read"] == 100_000
    assert result["throughput_mbps"] > 0
    assert result["sha256"]


def test_connection_timeline_records_only_state_transitions(tmp_path):
    timeline = ConnectionTimeline(str(tmp_path / "timeline.sqlite3"))
    timeline.record("AFC_READY", "phone", "connected")
    timeline.record("AFC_READY", "phone", "still connected")
    timeline.record("DISCONNECTED", "phone", "cable removed")

    events = timeline.events()
    assert [event["state"] for event in events] == ["DISCONNECTED", "AFC_READY"]
