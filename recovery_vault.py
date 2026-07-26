"""Recovery confidence reports and encrypted rescue vaults."""

from __future__ import annotations

import csv
import hashlib
import html
import json
import os
import struct
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Iterable

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

from recovery_queue import STREAM_CHUNK, VAULT_MAGIC, _now

def write_recovery_report(job: dict[str, Any], report_directory: str) -> dict[str, Any]:
    os.makedirs(report_directory, exist_ok=True)
    identifier = str(job.get("id") or "recovery")
    items = list(job.get("items") or [])
    complete = [item for item in items if item.get("status") == "complete" and item.get("sha256")]
    confidence = round(100 * len(complete) / len(items)) if items else 0
    basename = f"iDrivePulse-Recovery-{identifier}"
    csv_path = os.path.join(report_directory, basename + ".csv")
    html_path = os.path.join(report_directory, basename + ".html")
    fields = ["title", "status", "bytes", "sha256", "primary_path", "backup_path", "error"]
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as output:
        writer = csv.DictWriter(output, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(items)

    rows = "".join(
        "<tr>" + "".join(f"<td>{html.escape(str(item.get(field) or ''))}</td>" for field in fields) + "</tr>"
        for item in items
    )
    document = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>iDrivePulse Recovery Report</title><style>
body{{font-family:Segoe UI,Arial,sans-serif;background:#0b1020;color:#eaf0ff;margin:0;padding:32px}}
.card{{max-width:1200px;margin:auto;background:#141c33;border:1px solid #2a385d;border-radius:16px;padding:24px}}
.score{{font-size:42px;font-weight:800;color:#55e6b7}} table{{width:100%;border-collapse:collapse;margin-top:20px}}
th,td{{text-align:left;border-bottom:1px solid #2a385d;padding:10px;font-size:13px;word-break:break-word}}
th{{color:#9db1df}} .muted{{color:#9db1df}}</style></head><body><main class="card">
<h1>iDrivePulse Recovery Confidence Report</h1><div class="score">{confidence}% verified</div>
<p class="muted">Job {html.escape(identifier)} · {len(complete)} of {len(items)} selected files recovered and SHA-256 recorded.</p>
<table><thead><tr>{''.join(f'<th>{html.escape(field.replace("_", " ").title())}</th>' for field in fields)}</tr></thead>
<tbody>{rows}</tbody></table></main></body></html>"""
    with open(html_path, "w", encoding="utf-8") as output:
        output.write(document)
    return {"html": html_path, "csv": csv_path, "confidence": confidence}


def _derive_key(passphrase: str, salt: bytes) -> bytes:
    if not isinstance(passphrase, str) or len(passphrase) < 12:
        raise ValueError("Vault passphrase must contain at least 12 characters.")
    return Scrypt(salt=salt, length=32, n=2**15, r=8, p=1).derive(passphrase.encode("utf-8"))


def encrypt_to_vault(source_paths: Iterable[str], vault_path: str, passphrase: str) -> dict[str, Any]:
    sources = [os.path.abspath(path) for path in source_paths]
    if not sources or any(not os.path.isfile(path) for path in sources):
        raise ValueError("Every selected vault source must be an existing file.")
    vault_path = os.path.abspath(vault_path)
    os.makedirs(os.path.dirname(vault_path), exist_ok=True)
    archive_handle, archive_path = tempfile.mkstemp(prefix="idrivepulse-vault-", suffix=".zip")
    os.close(archive_handle)
    try:
        used: set[str] = set()
        manifest = []
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            for index, source in enumerate(sources, start=1):
                name = os.path.basename(source)
                if name.casefold() in used:
                    stem, extension = os.path.splitext(name)
                    name = f"{stem}_{index}{extension}"
                used.add(name.casefold())
                archive.write(source, arcname=f"files/{name}")
                manifest.append({"name": name, "source": source, "size": os.path.getsize(source)})
            archive.writestr("manifest.json", json.dumps({"created_at": _now(), "files": manifest}, indent=2))

        salt, nonce = os.urandom(16), os.urandom(12)
        key = _derive_key(passphrase, salt)
        header = json.dumps(
            {"cipher": "AES-256-GCM", "kdf": "scrypt", "salt": salt.hex(), "nonce": nonce.hex()},
            separators=(",", ":"),
        ).encode("utf-8")
        encryptor = Cipher(algorithms.AES(key), modes.GCM(nonce)).encryptor()
        partial = vault_path + ".part"
        with open(archive_path, "rb") as source, open(partial, "wb") as output:
            output.write(VAULT_MAGIC)
            output.write(struct.pack(">I", len(header)))
            output.write(header)
            while chunk := source.read(STREAM_CHUNK):
                output.write(encryptor.update(chunk))
            output.write(encryptor.finalize())
            output.write(encryptor.tag)
            output.flush()
            os.fsync(output.fileno())
        os.replace(partial, vault_path)
        return {
            "vault": vault_path,
            "file_count": len(sources),
            "bytes": os.path.getsize(vault_path),
            "sha256": _sha256(vault_path),
            "cipher": "AES-256-GCM",
        }
    finally:
        try:
            os.remove(archive_path)
        except FileNotFoundError:
            pass


def decrypt_vault(vault_path: str, output_directory: str, passphrase: str) -> dict[str, Any]:
    vault_path = os.path.abspath(vault_path)
    output_directory = os.path.abspath(output_directory)
    os.makedirs(output_directory, exist_ok=True)
    archive_handle, archive_path = tempfile.mkstemp(prefix="idrivepulse-restore-", suffix=".zip")
    os.close(archive_handle)
    try:
        with open(vault_path, "rb") as source:
            if source.read(len(VAULT_MAGIC)) != VAULT_MAGIC:
                raise ValueError("This is not an iDrivePulse rescue vault.")
            header_size_raw = source.read(4)
            if len(header_size_raw) != 4:
                raise ValueError("The rescue vault header is incomplete.")
            header_size = struct.unpack(">I", header_size_raw)[0]
            if header_size > 16_384:
                raise ValueError("The rescue vault header is invalid.")
            header = json.loads(source.read(header_size))
            salt, nonce = bytes.fromhex(header["salt"]), bytes.fromhex(header["nonce"])
            payload_start = source.tell()
            source.seek(0, os.SEEK_END)
            payload_end = source.tell() - 16
            if payload_end < payload_start:
                raise ValueError("The rescue vault is incomplete.")
            source.seek(payload_end)
            tag = source.read(16)
            source.seek(payload_start)
            decryptor = Cipher(algorithms.AES(_derive_key(passphrase, salt)), modes.GCM(nonce, tag)).decryptor()
            remaining = payload_end - payload_start
            try:
                with open(archive_path, "wb") as output:
                    while remaining:
                        chunk = source.read(min(STREAM_CHUNK, remaining))
                        if not chunk:
                            raise ValueError("The rescue vault ended early.")
                        remaining -= len(chunk)
                        output.write(decryptor.update(chunk))
                    output.write(decryptor.finalize())
            except InvalidTag as exc:
                raise ValueError("Incorrect passphrase or damaged rescue vault.") from exc

        restored: list[str] = []
        root = Path(output_directory).resolve()
        with zipfile.ZipFile(archive_path, "r") as archive:
            for member in archive.infolist():
                if member.is_dir() or member.filename == "manifest.json":
                    continue
                target = (root / member.filename).resolve()
                if root not in target.parents:
                    raise ValueError("Unsafe path found in rescue vault.")
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as source, open(target, "wb") as output:
                    while chunk := source.read(STREAM_CHUNK):
                        output.write(chunk)
                restored.append(str(target))
        return {"output_directory": output_directory, "files": restored, "file_count": len(restored)}
    finally:
        try:
            os.remove(archive_path)
        except FileNotFoundError:
            pass


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        while chunk := source.read(STREAM_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()
