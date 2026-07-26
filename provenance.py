"""Owner-controlled, tamper-evident provenance sidecars for recovered assets."""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from chunk_vault import merkle_root


def _canonical(value: dict) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


class ProtectedSigningKey:
    """Ed25519 key protected with Windows DPAPI when available."""

    def __init__(self, path: str):
        self.path = os.path.abspath(path)
        os.makedirs(os.path.dirname(self.path), exist_ok=True)

    @staticmethod
    def _protect(payload: bytes) -> bytes:
        if os.name == "nt":
            try:
                import win32crypt
                return b"DPAPI1" + win32crypt.CryptProtectData(payload, "iDrivePulse provenance key", None, None, None, 0)
            except (ImportError, OSError):
                pass
        return b"RAW001" + payload

    @staticmethod
    def _unprotect(payload: bytes) -> bytes:
        if payload.startswith(b"DPAPI1"):
            import win32crypt
            return win32crypt.CryptUnprotectData(payload[6:], None, None, None, 0)[1]
        if payload.startswith(b"RAW001"):
            return payload[6:]
        raise ValueError("Unknown protected-key format.")

    def load_or_create(self) -> Ed25519PrivateKey:
        if os.path.isfile(self.path):
            return Ed25519PrivateKey.from_private_bytes(self._unprotect(Path(self.path).read_bytes()))
        key = Ed25519PrivateKey.generate()
        raw = key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())
        handle, temporary = tempfile.mkstemp(prefix="provenance-key-", dir=os.path.dirname(self.path))
        try:
            with os.fdopen(handle, "wb") as output:
                output.write(self._protect(raw))
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass
        finally:
            try:
                os.remove(temporary)
            except FileNotFoundError:
                pass
        return key


class ProvenanceService:
    def __init__(self, key_path: str):
        self.keys = ProtectedSigningKey(key_path)

    def status(self) -> dict:
        key = self.keys.load_or_create()
        public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        return {
            "algorithm": "Ed25519", "key_id": hashlib.sha256(public).hexdigest()[:24],
            "protected_by": "Windows DPAPI" if Path(self.keys.path).read_bytes().startswith(b"DPAPI1") else "local file permissions",
            "c2pa_backend": importlib.util.find_spec("c2pa") is not None,
            "c2pa_note": "A trusted X.509 signing credential is required for public C2PA trust.",
        }

    def create(
        self,
        source_paths: Iterable[str],
        output_path: str,
        assertions: dict | None = None,
        include_paths: bool = False,
    ) -> dict:
        paths = [os.path.abspath(path) for path in source_paths]
        if not paths or any(not os.path.isfile(path) for path in paths):
            raise ValueError("Every provenance ingredient must be an existing file.")
        ingredients = []
        for path in paths:
            digest = _sha256(path)
            ingredient = {"name": os.path.basename(path), "bytes": os.path.getsize(path), "sha256": digest}
            if include_paths:
                ingredient["local_path"] = path
            ingredients.append(ingredient)
        key = self.keys.load_or_create()
        public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        claim = {
            "format": "org.idrivepulse.provenance.v1", "created_at": datetime.now(timezone.utc).isoformat(),
            "claim_generator": "iDrivePulse Recovery Fabric", "algorithm": "Ed25519",
            "key_id": hashlib.sha256(public).hexdigest()[:24], "public_key": base64.b64encode(public).decode(),
            "collection_merkle_root": merkle_root([item["sha256"] for item in ingredients]),
            "ingredients": ingredients, "assertions": assertions or {},
        }
        document = {"claim": claim, "signature": base64.b64encode(key.sign(_canonical(claim))).decode()}
        output_path = os.path.abspath(output_path)
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix="provenance-", suffix=".json", dir=os.path.dirname(output_path))
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as output:
                json.dump(document, output, ensure_ascii=False, indent=2, sort_keys=True)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, output_path)
        finally:
            try:
                os.remove(temporary)
            except FileNotFoundError:
                pass
        return {"path": output_path, "key_id": claim["key_id"], "ingredients": len(ingredients),
                "collection_merkle_root": claim["collection_merkle_root"]}

    @staticmethod
    def verify(path: str, ingredient_root: str | None = None) -> dict:
        with open(path, "r", encoding="utf-8") as source:
            document = json.load(source)
        claim = document["claim"]
        public = Ed25519PublicKey.from_public_bytes(base64.b64decode(claim["public_key"]))
        try:
            public.verify(base64.b64decode(document["signature"]), _canonical(claim))
            signature_valid = True
        except Exception:
            signature_valid = False
        ingredients_valid, failures = True, []
        if ingredient_root:
            for ingredient in claim.get("ingredients", []):
                candidate = os.path.join(os.path.abspath(ingredient_root), ingredient["name"])
                if not os.path.isfile(candidate) or _sha256(candidate) != ingredient["sha256"]:
                    ingredients_valid = False
                    failures.append(ingredient["name"])
        return {"signature_valid": signature_valid, "ingredients_valid": ingredients_valid,
                "valid": signature_valid and ingredients_valid, "failures": failures, "claim": claim}
