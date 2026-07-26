from range_cache import RangeCache


def test_range_cache_hydrates_only_missing_blocks(tmp_path):
    payload = bytes(range(256)) * 600
    calls = []
    cache = RangeCache(str(tmp_path / "cache"), block_size=64 * 1024, quota_bytes=1024 * 1024)

    def fetch(offset, length):
        calls.append((offset, length))
        return payload[offset:offset + length]

    first = cache.read("phone:/beat.wav", len(payload), 100, 80_000, fetch)
    call_count = len(calls)
    second = cache.read("phone:/beat.wav", len(payload), 200, 10_000, fetch)
    assert first == payload[100:80_100]
    assert second == payload[200:10_200]
    assert len(calls) == call_count
    assert cache.status()["blocks"] == 2
