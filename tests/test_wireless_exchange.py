import hashlib

from fastapi.testclient import TestClient

from wireless_exchange import PairingAuthority, WirelessExchange, build_wireless_app, ensure_certificate


def test_pairing_code_is_single_use_and_attempt_limited():
    authority = PairingAuthority()
    pairing = authority.begin()
    token = authority.claim(pairing["code"])
    assert authority.verify(token)
    try:
        authority.claim(pairing["code"])
    except PermissionError:
        pass
    else:
        raise AssertionError("Pairing code was reusable")

    authority.begin()
    for _ in range(8):
        try:
            authority.claim("not-the-code")
        except PermissionError:
            pass
    assert authority.status()["pairing_open"] is False


def test_wireless_api_pairs_uploads_lists_and_downloads(tmp_path):
    exchange = WirelessExchange(str(tmp_path / "exchange"))
    code = exchange.authority.begin()["code"]
    client = TestClient(build_wireless_app(exchange))
    response = client.post("/v1/pair", json={"code": code})
    assert response.status_code == 200
    token = response.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    payload = b"owner-created-beat" * 1024
    response = client.post(
        "/v1/files", content=payload,
        headers={**headers, "X-iDrivePulse-Filename": "my beat.wav", "Content-Type": "application/octet-stream"},
    )
    assert response.status_code == 200
    assert response.json()["sha256"] == hashlib.sha256(payload).hexdigest()

    listing = client.get("/v1/files", headers=headers).json()["files"]
    assert listing == [{"name": "my beat.wav", "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}]
    assert client.get("/v1/files/my%20beat.wav", headers=headers).content == payload
    assert client.get("/v1/files").status_code == 401


def test_certificate_fingerprint_is_stable(tmp_path):
    first = ensure_certificate(str(tmp_path), "127.0.0.1")
    second = ensure_certificate(str(tmp_path), "127.0.0.1")
    assert first[2] == second[2]
    assert len(first[2]) == 64
