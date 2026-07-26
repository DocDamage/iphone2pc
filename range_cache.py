"""Persistent block hydration cache for random-access AFC reads."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable


class RangeCache:
    def __init__(self, root: str, block_size: int = 1024 * 1024, quota_bytes: int = 20 * 1024**3):
        self.root = os.path.abspath(root)
        self.block_size = max(64 * 1024, int(block_size))
        self.quota_bytes = max(self.block_size, int(quota_bytes))
        os.makedirs(self.root, exist_ok=True)
        self._locks: dict[str, threading.RLock] = {}
        self._guard = threading.RLock()

    def _key(self, identifier: str, size: int) -> str:
        return hashlib.sha256(f"{identifier}\0{size}".encode()).hexdigest()

    def _directory(self, key: str) -> str:
        return os.path.join(self.root, key[:2], key)

    def _lock(self, key: str):
        with self._guard:
            return self._locks.setdefault(key, threading.RLock())

    def _block_path(self, key: str, index: int) -> str:
        return os.path.join(self._directory(key), f"{index:08x}.block")

    def _publish(self, path: str, payload: bytes):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix="hydrate-", dir=os.path.dirname(path))
        try:
            with os.fdopen(handle, "wb") as output:
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            try:
                os.remove(temporary)
            except FileNotFoundError:
                pass

    def read(self, identifier: str, size: int, offset: int, length: int, fetch: Callable[[int, int], bytes]) -> bytes:
        size, offset = max(0, int(size)), max(0, int(offset))
        length = max(0, min(int(length), size - offset))
        if not length:
            return b""
        key = self._key(identifier, size)
        first, last = offset // self.block_size, (offset + length - 1) // self.block_size
        blocks = []
        with self._lock(key):
            for index in range(first, last + 1):
                block_offset = index * self.block_size
                expected = min(self.block_size, size - block_offset)
                path = self._block_path(key, index)
                if os.path.isfile(path) and os.path.getsize(path) == expected:
                    payload = Path(path).read_bytes()
                    os.utime(path, None)
                else:
                    payload = bytes(fetch(block_offset, expected))
                    if len(payload) != expected:
                        raise IOError(f"Hydration returned {len(payload)} of {expected} requested bytes.")
                    self._publish(path, payload)
                blocks.append(payload)
            metadata = {"identifier": identifier, "size": size, "block_size": self.block_size, "touched_at": time.time()}
            self._publish(os.path.join(self._directory(key), "metadata.json"), json.dumps(metadata).encode())
        joined = b"".join(blocks)
        start = offset - first * self.block_size
        self.enforce_quota()
        return joined[start:start + length]

    def enforce_quota(self):
        blocks = [path for path in Path(self.root).rglob("*.block") if path.is_file()]
        total = sum(path.stat().st_size for path in blocks)
        if total <= self.quota_bytes:
            return
        for path in sorted(blocks, key=lambda item: item.stat().st_mtime):
            size = path.stat().st_size
            try:
                path.unlink()
                total -= size
            except FileNotFoundError:
                pass
            if total <= self.quota_bytes:
                break

    def clear(self) -> int:
        removed = 0
        for path in Path(self.root).rglob("*.block"):
            try:
                path.unlink()
                removed += 1
            except FileNotFoundError:
                pass
        return removed

    def status(self) -> dict:
        blocks = [path for path in Path(self.root).rglob("*.block") if path.is_file()]
        stored = sum(path.stat().st_size for path in blocks)
        return {"root": self.root, "block_size": self.block_size, "quota_bytes": self.quota_bytes,
                "stored_bytes": stored, "blocks": len(blocks), "utilization": round(stored / self.quota_bytes * 100, 2)}
