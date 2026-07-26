import json

from provenance import ProvenanceService


def test_provenance_is_signed_and_detects_claim_tampering(tmp_path):
    beat = tmp_path / "beat.wav"
    beat.write_bytes(b"original-beat")
    service = ProvenanceService(str(tmp_path / "key.bin"))
    sidecar = tmp_path / "beat.idrivepulse-provenance.json"
    service.create([str(beat)], str(sidecar), {"source": "iphone-afc"})

    assert service.verify(str(sidecar), str(tmp_path))["valid"] is True
    document = json.loads(sidecar.read_text("utf-8"))
    document["claim"]["assertions"]["source"] = "changed"
    sidecar.write_text(json.dumps(document), "utf-8")
    assert service.verify(str(sidecar))["signature_valid"] is False


def test_provenance_key_is_stable(tmp_path):
    path = tmp_path / "key.bin"
    first = ProvenanceService(str(path)).status()["key_id"]
    second = ProvenanceService(str(path)).status()["key_id"]
    assert first == second
