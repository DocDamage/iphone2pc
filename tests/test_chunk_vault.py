from chunk_vault import ChunkVault, content_defined_chunks, merkle_root


def test_content_defined_chunks_are_bounded_and_deterministic(tmp_path):
    payload = (b"beat-pattern-" * 400_000) + b"tail"
    source = tmp_path / "beat.wav"
    source.write_bytes(payload)
    with source.open("rb") as handle:
        first = list(content_defined_chunks(handle))
    with source.open("rb") as handle:
        second = list(content_defined_chunks(handle))
    assert first == second
    assert b"".join(first) == payload
    assert all(len(chunk) <= 4 * 1024 * 1024 for chunk in first)


def test_chunk_vault_deduplicates_verifies_and_reconstructs(tmp_path):
    vault = ChunkVault(str(tmp_path / "vault"))
    first = tmp_path / "one.wav"
    second = tmp_path / "two.wav"
    payload = b"same-original-beat" * 100_000
    first.write_bytes(payload)
    second.write_bytes(payload)

    one = vault.ingest(str(first), source_kind="recovery")
    two = vault.ingest(str(second), source_kind="backup")
    restored = tmp_path / "restored.wav"

    assert one["sha256"] == two["sha256"]
    assert two["new_chunks"] == 0
    assert vault.verify(one["id"])["valid"] is True
    assert vault.reconstruct(one["id"], str(restored))["bytes"] == len(payload)
    assert restored.read_bytes() == payload
    assert vault.stats()["deduplicated_bytes"] >= len(payload)


def test_merkle_root_is_stable():
    hashes = ["00" * 32, "11" * 32, "22" * 32]
    assert merkle_root(hashes) == merkle_root(list(hashes))
    assert len(merkle_root(hashes)) == 64
