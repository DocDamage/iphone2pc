from diagnostic_analytics import DiagnosticAnalytics


def test_diagnostic_analytics_scores_history_and_detects_decline(tmp_path):
    analytics = DiagnosticAnalytics(str(tmp_path / "diagnostics.sqlite3"))
    for speed in [22, 20, 17, 13, 9]:
        analytics.record({"throughput_mbps": speed, "median_chunk_ms": 40, "maximum_stall_ms": 300, "jitter_ms": 20}, "phone")
    prediction = analytics.prediction("phone")
    assert prediction["samples"] == 5
    assert prediction["throughput_slope"] < 0
    assert "declining" in prediction["recommendation"]
