"""Opt-in, certificate-pinned LAN exchange used only by the iOS companion."""

from __future__ import annotations

import hashlib
import ipaddress
import os
import secrets
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import uvicorn
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse

from app_core import DATA_DIR, get_local_ip, safe_filename


class PairingAuthority:
    def __init__(self):
        self.code_hash: bytes | None = None
        self.code_expires = 0.0
        self.tokens: dict[bytes, float] = {}
        self.failed_attempts = 0
        self._lock = threading.RLock()

    @staticmethod
    def _hash(value: str) -> bytes:
        return hashlib.sha256(value.encode()).digest()

    def begin(self, lifetime_seconds: int = 300) -> dict:
        code = f"{secrets.randbelow(1_000_000):06d}"
        with self._lock:
            self.code_hash = self._hash(code)
            self.code_expires = time.time() + lifetime_seconds
            self.failed_attempts = 0
        return {"code": code, "expires_at": self.code_expires}

    def claim(self, code: str) -> str:
        with self._lock:
            valid = self.code_hash and time.time() <= self.code_expires
            valid = valid and secrets.compare_digest(self.code_hash, self._hash(str(code)))
            if not valid:
                self.failed_attempts += 1
                if self.failed_attempts >= 8:
                    self.code_hash = None
                raise PermissionError("The pairing code is invalid or expired.")
            self.code_hash = None
            self.failed_attempts = 0
            token = secrets.token_urlsafe(48)
            self.tokens[self._hash(token)] = time.time() + 30 * 24 * 60 * 60
            return token

    def verify(self, token: str) -> bool:
        digest, now = self._hash(token), time.time()
        with self._lock:
            self.tokens = {key: expiry for key, expiry in self.tokens.items() if expiry > now}
            expiry = self.tokens.get(digest)
            return bool(expiry)

    def status(self) -> dict:
        with self._lock:
            return {"pairing_open": bool(self.code_hash and time.time() <= self.code_expires),
                    "pairing_expires_at": self.code_expires or None, "paired_tokens": len(self.tokens),
                    "failed_pairing_attempts": self.failed_attempts}


class WirelessExchange:
    def __init__(self, root: str):
        self.root = os.path.abspath(root)
        os.makedirs(self.root, exist_ok=True)
        self.authority = PairingAuthority()

    def path(self, name: str) -> str:
        clean = safe_filename(os.path.basename(str(name)))
        if not clean:
            raise ValueError("A valid filename is required.")
        return os.path.join(self.root, clean)

    @staticmethod
    def digest(path: str) -> str:
        value = hashlib.sha256()
        with open(path, "rb") as source:
            for payload in iter(lambda: source.read(4 * 1024 * 1024), b""):
                value.update(payload)
        return value.hexdigest()

    def files(self) -> list[dict]:
        results = []
        for entry in os.scandir(self.root):
            if entry.is_file() and not entry.name.startswith("."):
                results.append({"name": entry.name, "bytes": entry.stat().st_size, "sha256": self.digest(entry.path)})
        return sorted(results, key=lambda item: item["name"].casefold())


def build_wireless_app(exchange: WirelessExchange) -> FastAPI:
    application = FastAPI(title="iDrivePulse Secure Companion Exchange", docs_url=None, redoc_url=None)

    def authorize(header: str | None):
        token = header[7:] if header and header.startswith("Bearer ") else ""
        if not exchange.authority.verify(token):
            raise HTTPException(status_code=401, detail="Pair this iPhone again.")

    @application.post("/v1/pair")
    async def pair(request: Request):
        data = await request.json()
        try:
            return {"token": exchange.authority.claim(data.get("code", ""))}
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc

    @application.get("/v1/files")
    def list_files(authorization: str | None = Header(None)):
        authorize(authorization)
        return {"files": exchange.files()}

    @application.get("/v1/files/{name}")
    def download(name: str, authorization: str | None = Header(None)):
        authorize(authorization)
        try:
            path = exchange.path(name)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not os.path.isfile(path):
            raise HTTPException(status_code=404, detail="File not found.")
        return FileResponse(path, filename=os.path.basename(path), media_type="application/octet-stream")

    @application.post("/v1/files")
    async def upload(
        request: Request,
        authorization: str | None = Header(None),
        x_idrivepulse_filename: str | None = Header(None),
    ):
        authorize(authorization)
        try:
            destination = exchange.path(x_idrivepulse_filename or "")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if os.path.exists(destination):
            stem, extension = os.path.splitext(destination)
            destination = f"{stem} [{int(time.time())}]{extension}"
        handle, temporary = tempfile.mkstemp(prefix=".wireless-", dir=exchange.root)
        digest, size = hashlib.sha256(), 0
        try:
            with os.fdopen(handle, "wb") as output:
                async for payload in request.stream():
                    size += len(payload)
                    if size > 20 * 1024**3:
                        raise HTTPException(status_code=413, detail="Wireless transfer exceeds the 20 GiB limit.")
                    digest.update(payload)
                    output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, destination)
        finally:
            try:
                os.remove(temporary)
            except FileNotFoundError:
                pass
        return {"name": os.path.basename(destination), "bytes": size, "sha256": digest.hexdigest()}

    return application


def ensure_certificate(root: str, local_ip: str) -> tuple[str, str, str]:
    key_path, cert_path = os.path.join(root, "lan-key.pem"), os.path.join(root, "lan-cert.pem")
    if not (os.path.isfile(key_path) and os.path.isfile(cert_path)):
        key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "iDrivePulse Local Companion")])
        now = datetime.now(timezone.utc)
        san = [x509.DNSName("localhost")]
        try:
            san.append(x509.IPAddress(ipaddress.ip_address(local_ip)))
        except ValueError:
            pass
        certificate = x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        certificate = certificate.serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=1))
        certificate = certificate.not_valid_after(now + timedelta(days=3650)).add_extension(x509.SubjectAlternativeName(san), False)
        certificate = certificate.sign(key, hashes.SHA256())
        Path(key_path).write_bytes(key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()
        ))
        Path(cert_path).write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
        os.chmod(key_path, 0o600)
        if os.name == "nt":
            try:
                identity = subprocess.run(
                    ["whoami.exe"], capture_output=True, text=True, timeout=5,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                ).stdout.strip()
                if identity:
                    subprocess.run(
                        ["icacls.exe", key_path, "/inheritance:r", "/grant:r", f"{identity}:(R)"],
                        capture_output=True, timeout=10,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    )
            except (OSError, subprocess.TimeoutExpired):
                pass
    certificate = x509.load_pem_x509_certificate(Path(cert_path).read_bytes())
    fingerprint = certificate.fingerprint(hashes.SHA256()).hex()
    return key_path, cert_path, fingerprint


class WirelessServer:
    def __init__(self, port: int = 8766):
        self.port = port
        self.root = os.path.join(DATA_DIR, "wireless-exchange")
        self.exchange = WirelessExchange(self.root)
        self.server: uvicorn.Server | None = None
        self.thread: threading.Thread | None = None
        self.endpoint: str | None = None
        self.fingerprint: str | None = None

    def start(self) -> dict:
        local_ip = get_local_ip()
        if not self.thread or not self.thread.is_alive():
            os.makedirs(self.root, exist_ok=True)
            key, cert, self.fingerprint = ensure_certificate(self.root, local_ip)
            config = uvicorn.Config(
                build_wireless_app(self.exchange), host="0.0.0.0", port=self.port, log_level="warning",
                ssl_keyfile=key, ssl_certfile=cert,
            )
            self.server = uvicorn.Server(config)
            self.thread = threading.Thread(target=self.server.run, name="idrivepulse-wireless", daemon=True)
            self.thread.start()
            deadline = time.time() + 10
            while not self.server.started and self.thread.is_alive() and time.time() < deadline:
                time.sleep(0.05)
            if not self.server.started:
                raise RuntimeError("The secure companion server did not start.")
        self.endpoint = f"https://{local_ip}:{self.port}"
        return {**self.status(), **self.exchange.authority.begin()}

    def stop(self) -> dict:
        if self.server:
            self.server.should_exit = True
        if self.thread:
            self.thread.join(timeout=10)
        self.server = None
        self.thread = None
        return self.status()

    def status(self) -> dict:
        running = bool(self.thread and self.thread.is_alive() and self.server and self.server.started)
        return {"running": running, "endpoint": self.endpoint, "certificate_sha256": self.fingerprint,
                "exchange_root": self.root, **self.exchange.authority.status()}


WIRELESS_SERVER = WirelessServer(int(os.environ.get("IDRIVEPULSE_WIRELESS_PORT", "8766")))
