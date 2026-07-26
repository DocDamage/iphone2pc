from pathlib import Path

from recovery import QueueStore, decrypt_vault, encrypt_to_vault, write_recovery_report


def test_queue_persists_order_pause_resume_and_retry(tmp_path):
    store = QueueStore(str(tmp_path / "queue.sqlite3"))
    job_id = store.create_job(
        [
            {"id": "one", "iphone_path": "/one.wav", "title": "One", "size_bytes": 10},
            {"id": "two", "iphone_path": "/two.wav", "title": "Two", "size_bytes": 20},
        ],
        str(tmp_path / "primary"),
        backup_dir=str(tmp_path / "backup"),
    )

    store.pause_job(job_id)
    assert store.get_job(job_id)["status"] == "paused"
    store.resume_job(job_id)
    first = store.claim_next()
    assert first["track_id"] == "one"
    store.update_item(first["id"], status="failed", error="cable removed")
    store.retry_failed(job_id)
    store.reorder(job_id, ["two", "one"])

    job = store.get_job(job_id)
    assert [item["track_id"] for item in job["items"]] == ["two", "one"]
    assert {item["status"] for item in job["items"]} == {"queued"}


def test_encrypted_vault_round_trip(tmp_path):
    source = tmp_path / "beat.wav"
    source.write_bytes(b"my original beat" * 1000)
    vault = tmp_path / "rescue.idrivevault"

    result = encrypt_to_vault([str(source)], str(vault), "correct horse battery staple")
    source.unlink()
    restored = decrypt_vault(str(vault), str(tmp_path / "restored"), "correct horse battery staple")

    assert result["file_count"] == 1
    assert Path(restored["files"][0]).read_bytes() == b"my original beat" * 1000
    assert b"my original beat" not in vault.read_bytes()


def test_recovery_report_contains_verification_status(tmp_path):
    job = {
        "id": "job-1",
        "status": "completed",
        "output_dir": str(tmp_path),
        "items": [
            {
                "track_id": "one",
                "title": "Recovered Beat",
                "status": "complete",
                "bytes": 42,
                "sha256": "abc123",
                "primary_path": str(tmp_path / "Recovered Beat.wav"),
                "backup_path": None,
                "error": None,
            }
        ],
    }
    report = write_recovery_report(job, str(tmp_path))

    assert Path(report["html"]).exists()
    assert Path(report["csv"]).exists()
    assert report["confidence"] == 100
    assert "Recovered Beat" in Path(report["html"]).read_text(encoding="utf-8")
