"""Content-addressed, chunk-resumable storage for recovered files."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Iterable


MIN_CHUNK = 256 * 1024
TARGET_CHUNK = 1024 * 1024
MAX_CHUNK = 4 * 1024 * 1024
READ_SIZE = 64 * 1024
GEAR = tuple(int.from_bytes(hashlib.sha256(bytes([value])).digest()[:8], "big") for value in range(256))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def content_defined_chunks(
    source: BinaryIO,
    minimum: int = MIN_CHUNK,
    target: int = TARGET_CHUNK,
    maximum: int = MAX_CHUNK,
) -> Iterable[bytes]:
    """Yield deterministic Gear-hash chunks while keeping memory bounded."""
    if not 0 < minimum <= target <= maximum:
        raise ValueError("Chunk sizes must satisfy 0 < minimum <= target <= maximum.")
    mask = (1 << max(1, target.bit_length() - 1)) - 1
    payload = bytearray()
    rolling = 0
    while block := source.read(READ_SIZE):
        for value in block:
            payload.append(value)
            rolling = ((rolling << 1) + GEAR[value]) & 0xFFFFFFFFFFFFFFFF
            boundary = len(payload) >= minimum and ((rolling & mask) == 0 or len(payload) >= maximum)
            if boundary:
                yield bytes(payload)
                payload.clear()
                rolling = 0
    if payload:
        yield bytes(payload)


def merkle_root(hashes: list[str]) -> str:
    if not hashes:
        return hashlib.sha256(b"").hexdigest()
    level = [bytes.fromhex(value) for value in hashes]
    while len(level) > 1:
        if len(level) % 2:
            level.append(level[-1])
        level = [hashlib.sha256(level[index] + level[index + 1]).digest() for index in range(0, len(level), 2)]
    return level[0].hex()


class ChunkVault:
    """SQLite manifest index backed by immutable SHA-256-addressed chunks."""

    def __init__(self, root: str):
        self.root = os.path.abspath(root)
        self.chunk_root = os.path.join(self.root, "chunks")
        self.database_path = os.path.join(self.root, "manifests.sqlite3")
        os.makedirs(self.chunk_root, exist_ok=True)
        self._lock = threading.RLock()
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS manifests (
                    id TEXT PRIMARY KEY, source_path TEXT, source_kind TEXT NOT NULL,
                    display_name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
                    merkle_root TEXT NOT NULL, chunks_json TEXT NOT NULL,
                    metadata_json TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_manifest_sha ON manifests(sha256);
                """
            )

    def _connect(self):
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        return connection

    def _chunk_path(self, digest: str) -> str:
        return os.path.join(self.chunk_root, digest[:2], digest[2:4], digest)

    def _store_chunk(self, digest: str, payload: bytes) -> bool:
        destination = self._chunk_path(digest)
        if os.path.isfile(destination) and os.path.getsize(destination) == len(payload):
            return False
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix="chunk-", dir=os.path.dirname(destination))
        try:
            with os.fdopen(handle, "wb") as output:
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            if hashlib.sha256(Path(temporary).read_bytes()).hexdigest() != digest:
                raise IOError("Chunk verification failed before publication.")
            if not os.path.exists(destination):
                os.replace(temporary, destination)
            return True
        finally:
            try:
                os.remove(temporary)
            except FileNotFoundError:
                pass

    def ingest(self, path: str, source_kind: str = "pc", metadata: dict | None = None) -> dict:
        path = os.path.abspath(path)
        if not os.path.isfile(path):
            raise FileNotFoundError(path)
        overall = hashlib.sha256()
        chunks, new_chunks = [], 0
        with open(path, "rb") as source:
            for payload in content_defined_chunks(source):
                digest = hashlib.sha256(payload).hexdigest()
                overall.update(payload)
                new_chunks += int(self._store_chunk(digest, payload))
                chunks.append({"sha256": digest, "size": len(payload)})
        digest = overall.hexdigest()
        identifier = "manifest_" + uuid.uuid5(uuid.NAMESPACE_URL, f"{digest}:{os.path.basename(path)}").hex
        record = {
            "id": identifier, "source_path": path, "source_kind": source_kind,
            "display_name": os.path.basename(path), "size": os.path.getsize(path),
            "sha256": digest, "merkle_root": merkle_root([item["sha256"] for item in chunks]),
            "chunks": chunks, "metadata": metadata or {}, "created_at": _now(), "new_chunks": new_chunks,
        }
        with self._lock, self._connect() as connection:
            connection.execute(
                """INSERT OR REPLACE INTO manifests
                (id,source_path,source_kind,display_name,size,sha256,merkle_root,chunks_json,metadata_json,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (identifier, path, source_kind, record["display_name"], record["size"], digest,
                 record["merkle_root"], json.dumps(chunks), json.dumps(record["metadata"], default=str), record["created_at"]),
            )
        return record

    def manifest(self, identifier: str) -> dict | None:
        with self._lock, self._connect() as connection:
            row = connection.execute("SELECT * FROM manifests WHERE id=?", (identifier,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["chunks"] = json.loads(result.pop("chunks_json"))
        result["metadata"] = json.loads(result.pop("metadata_json"))
        return result

    def list_manifests(self, limit: int = 500) -> list[dict]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM manifests ORDER BY created_at DESC LIMIT ?", (max(1, min(limit, 5000)),)
            ).fetchall()
        return [self.manifest(row["id"]) for row in rows]

    def verify(self, identifier: str, deep: bool = True) -> dict:
        manifest = self.manifest(identifier)
        if not manifest:
            raise KeyError(identifier)
        missing, damaged = [], []
        for chunk in manifest["chunks"]:
            path = self._chunk_path(chunk["sha256"])
            if not os.path.isfile(path) or os.path.getsize(path) != chunk["size"]:
                missing.append(chunk["sha256"])
            elif deep:
                with open(path, "rb") as source:
                    if hashlib.sha256(source.read()).hexdigest() != chunk["sha256"]:
                        damaged.append(chunk["sha256"])
        return {"id": identifier, "valid": not missing and not damaged, "missing": missing, "damaged": damaged,
                "chunk_count": len(manifest["chunks"]), "merkle_root": manifest["merkle_root"]}

    def reconstruct(self, identifier: str, destination: str) -> dict:
        manifest = self.manifest(identifier)
        if not manifest:
            raise KeyError(identifier)
        destination = os.path.abspath(destination)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        partial = destination + ".part"
        digest = hashlib.sha256()
        with open(partial, "wb") as output:
            for chunk in manifest["chunks"]:
                path = self._chunk_path(chunk["sha256"])
                with open(path, "rb") as source:
                    payload = source.read()
                if len(payload) != chunk["size"] or hashlib.sha256(payload).hexdigest() != chunk["sha256"]:
                    raise IOError(f"Missing or damaged vault chunk {chunk['sha256']}.")
                digest.update(payload)
                output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        if digest.hexdigest() != manifest["sha256"]:
            raise IOError("Reconstructed file does not match its manifest.")
        os.replace(partial, destination)
        return {"path": destination, "bytes": os.path.getsize(destination), "sha256": digest.hexdigest()}

    def stats(self) -> dict:
        files = [entry for entry in Path(self.chunk_root).rglob("*") if entry.is_file()]
        manifests = self.list_manifests(limit=5000)
        logical = sum(item["size"] for item in manifests)
        stored = sum(item.stat().st_size for item in files)
        return {"manifests": len(manifests), "chunks": len(files), "logical_bytes": logical,
                "stored_bytes": stored, "deduplicated_bytes": max(0, logical - stored)}
