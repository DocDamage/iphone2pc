"""Bounded, resumable file transfer primitives for Apple AFC."""

from app_core import *
from app_device import *

def get_registered_track(track_id: str) -> dict:
    with TRACK_REGISTRY_LOCK:
        track = TRACK_REGISTRY.get(track_id)
        return dict(track) if track else MEDIA_CATALOG.get_track(track_id)


def copy_afc_file(
    source_path: str,
    destination_path: str,
    expected_size: Optional[int] = None,
    device_bridge=None,
) -> int:
    """Copy one AFC file in bounded chunks, resuming an existing partial file."""
    active_bridge = device_bridge or bridge
    if not active_bridge.connected or not active_bridge.afc:
        success, message = active_bridge.connect(force=True)
        if not success or not active_bridge.afc:
            raise RuntimeError(message or "No iPhone connected over USB.")
    source_path = normalize_afc_path(source_path)
    if expected_size is None:
        expected_size = int(active_bridge.afc.stat(source_path).get("st_size", 0) or 0)
    expected_size = int(expected_size)

    os.makedirs(os.path.dirname(os.path.abspath(destination_path)), exist_ok=True)
    partial_path = f"{destination_path}.part"
    handle = None
    copied = os.path.getsize(partial_path) if os.path.exists(partial_path) else 0
    if copied > expected_size:
        os.remove(partial_path)
        copied = 0
    if copied == expected_size:
        os.replace(partial_path, destination_path)
        return copied

    try:
        handle = active_bridge.afc.fopen(source_path, "r")
        if copied:
            seek = getattr(active_bridge.afc, "fseek", None)
            if callable(seek):
                seek(handle, copied, 0)
            else:
                # Compatibility fallback for older AFC wrappers that do not expose
                # FileRefSeek. It preserves the local partial but must discard bytes.
                skipped = 0
                while skipped < copied:
                    chunk = active_bridge.afc.fread(handle, min(TRANSFER_CHUNK_SIZE, copied - skipped))
                    if not chunk:
                        raise IOError(f"Could not restore the AFC read position at byte {copied}.")
                    skipped += len(chunk)

        with transfer_power_guard():
            with open(partial_path, "ab" if copied else "wb") as output:
                while copied < expected_size:
                    chunk = active_bridge.afc.fread(handle, min(TRANSFER_CHUNK_SIZE, expected_size - copied))
                    if not chunk:
                        raise IOError(f"Transfer ended early after {copied} of {expected_size} bytes.")
                    output.write(chunk)
                    copied += len(chunk)
                output.flush()
                os.fsync(output.fileno())
        if copied != expected_size:
            raise IOError(f"Transferred {copied} bytes; expected {expected_size}.")
        os.replace(partial_path, destination_path)
        return copied
    finally:
        if handle is not None:
            try:
                active_bridge.afc.fclose(handle)
            except Exception:
                pass
