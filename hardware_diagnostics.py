"""Windows USB/kernel diagnostics and non-destructive AFC cable benchmarking."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import statistics
import subprocess
import threading
import time
from datetime import datetime, timezone
from typing import Any


class ConnectionTimeline:
    def __init__(self, database_path: str):
        self.database_path = os.path.abspath(database_path)
        os.makedirs(os.path.dirname(self.database_path), exist_ok=True)
        self._lock = threading.RLock()
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS connection_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL,
                    state TEXT NOT NULL, device_key TEXT, detail TEXT
                )
                """
            )

    def _connect(self):
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        return connection

    def record(self, state: str, device_key: str | None = None, detail: str | None = None) -> bool:
        with self._lock, self._connect() as connection:
            previous = connection.execute(
                "SELECT state, device_key FROM connection_events ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if previous and previous["state"] == state and previous["device_key"] == device_key:
                return False
            connection.execute(
                "INSERT INTO connection_events(occurred_at, state, device_key, detail) VALUES (?, ?, ?, ?)",
                (datetime.now(timezone.utc).isoformat(), state, device_key, detail),
            )
        return True

    def events(self, limit: int = 200) -> list[dict[str, Any]]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM connection_events ORDER BY id DESC LIMIT ?", (max(1, min(limit, 5000)),)
            ).fetchall()
        return [dict(row) for row in rows]


def benchmark_afc(afc, path: str, max_bytes: int = 64 * 1024 * 1024, chunk_size: int = 1024 * 1024) -> dict[str, Any]:
    """Read a bounded sample without modifying or retaining the source bytes."""
    expected = min(int(afc.stat(path).get("st_size", 0) or 0), max(1, int(max_bytes)))
    if expected <= 0:
        raise ValueError("The benchmark source is empty.")
    digest = hashlib.sha256()
    handle = afc.fopen(path, "r")
    read_total = 0
    latencies = []
    start = time.perf_counter()
    try:
        while read_total < expected:
            chunk_start = time.perf_counter()
            chunk = afc.fread(handle, min(chunk_size, expected - read_total))
            latencies.append((time.perf_counter() - chunk_start) * 1000)
            if not chunk:
                break
            digest.update(chunk)
            read_total += len(chunk)
    finally:
        afc.fclose(handle)
    elapsed = max(time.perf_counter() - start, 1e-9)
    throughput = read_total / elapsed / (1024 * 1024)
    maximum_stall = max(latencies, default=0.0)
    median = statistics.median(latencies) if latencies else 0.0
    jitter = statistics.pstdev(latencies) if len(latencies) > 1 else 0.0
    if read_total != expected:
        health = "transfer-ended-early"
    elif throughput >= 15 and maximum_stall < 750:
        health = "excellent"
    elif throughput >= 5 and maximum_stall < 2000:
        health = "good"
    else:
        health = "check-cable-or-port"
    return {
        "source": path,
        "bytes_read": read_total,
        "sample_limit_bytes": expected,
        "elapsed_seconds": round(elapsed, 4),
        "throughput_mbps": round(throughput, 2),
        "median_chunk_ms": round(median, 2),
        "maximum_stall_ms": round(maximum_stall, 2),
        "jitter_ms": round(jitter, 2),
        "chunks": len(latencies),
        "sha256": digest.hexdigest(),
        "health": health,
        "interpretation": "This measures the full AFC/USB path; a slow result can come from the cable, port, hub, phone storage, or software stack.",
    }


def _powershell_json(script: str, timeout: int = 45):
    process = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, text=True, timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if process.returncode != 0:
        raise RuntimeError((process.stderr or process.stdout or "PowerShell diagnostic failed.").strip())
    text = process.stdout.strip()
    return json.loads(text) if text else []


def windows_kernel_snapshot() -> dict[str, Any]:
    topology_script = r"""
    $items = Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like '*VID_05AC*' }
    @($items | ForEach-Object {
      $d=$_
      [PSCustomObject]@{
        Status=$d.Status; Class=$d.Class; FriendlyName=$d.FriendlyName; InstanceId=$d.InstanceId
        Parent=(Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_Parent' -ErrorAction SilentlyContinue).Data
        Location=(Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_LocationInfo' -ErrorAction SilentlyContinue).Data
        BusDescription=(Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_BusReportedDeviceDesc' -ErrorAction SilentlyContinue).Data
        DriverVersion=(Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_DriverVersion' -ErrorAction SilentlyContinue).Data
        DriverProvider=(Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_DriverProvider' -ErrorAction SilentlyContinue).Data
      }
    }) | ConvertTo-Json -Depth 5 -Compress
    """
    drivers_script = r"""
    $pnp = Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceID -like '*VID_05AC*' -or $_.DeviceName -like '*WinFsp*' }
    $kernel = Get-CimInstance Win32_SystemDriver | Where-Object { $_.Name -match 'USB|WinFsp|Apple' -and $_.State -eq 'Running' }
    [PSCustomObject]@{
      SignedPnP=@($pnp | Select-Object DeviceName,DeviceID,DriverProviderName,DriverVersion,InfName,IsSigned,Signer)
      RunningKernelDrivers=@($kernel | Select-Object Name,DisplayName,State,StartMode,PathName)
    } | ConvertTo-Json -Depth 6 -Compress
    """
    registry_script = r"""
    $services = Get-CimInstance Win32_Service | Where-Object { $_.Name -match 'Apple|Bonjour|usbmux' -or $_.DisplayName -match 'Apple|Bonjour' }
    $serviceData = @($services | ForEach-Object {
      $s=$_; $key='HKLM:\SYSTEM\CurrentControlSet\Services\'+$s.Name
      $reg=Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
      [PSCustomObject]@{Name=$s.Name;DisplayName=$s.DisplayName;State=$s.State;StartMode=$s.StartMode;PathName=$s.PathName;RegistryStart=$reg.Start;RegistryType=$reg.Type;RegistryImagePath=$reg.ImagePath}
    })
    $usb = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\USBXHCI' -ErrorAction SilentlyContinue
    [PSCustomObject]@{AppleServices=$serviceData;USBXHCI=[PSCustomObject]@{Start=$usb.Start;Type=$usb.Type;ImagePath=$usb.ImagePath}} | ConvertTo-Json -Depth 6 -Compress
    """
    events_script = r"""
    $start=(Get-Date).AddDays(-1)
    @((Get-WinEvent -FilterHashtable @{LogName='System';StartTime=$start} -ErrorAction SilentlyContinue |
      Where-Object { $_.ProviderName -match 'USB|Kernel-PnP' -and $_.Level -le 3 } |
      Select-Object -First 50 TimeCreated,ProviderName,Id,LevelDisplayName,Message)) | ConvertTo-Json -Depth 4 -Compress
    """
    errors = []
    results = {}
    for name, script in (
        ("usb_topology", topology_script), ("drivers", drivers_script),
        ("registry_and_services", registry_script), ("recent_usb_errors", events_script),
    ):
        try:
            results[name] = _powershell_json(script)
        except Exception as exc:
            results[name] = None
            errors.append({"section": name, "reason": str(exc)})
    results["errors"] = errors
    results["captured_at"] = datetime.now(timezone.utc).isoformat()
    return results


class ETWRecorder:
    SESSION_NAME = "iDrivePulseUSBTrace"

    def __init__(self, output_root: str):
        self.output_root = os.path.abspath(output_root)
        os.makedirs(self.output_root, exist_ok=True)
        self._lock = threading.RLock()
        self.output_path: str | None = None
        self.started_at: str | None = None

    def start(self) -> dict[str, Any]:
        with self._lock:
            if self.output_path:
                return self.status()
            output = os.path.join(self.output_root, f"usb-trace-{datetime.now().strftime('%Y%m%d-%H%M%S')}.etl")
            command = [
                "logman.exe", "start", self.SESSION_NAME, "-ets", "-o", output,
                "-p", "Microsoft-Windows-USB-USBHUB3", "0xFFFFFFFF", "5",
            ]
            process = subprocess.run(
                command, capture_output=True, text=True, timeout=20,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if process.returncode != 0:
                raise PermissionError((process.stderr or process.stdout or "Could not start ETW recording.").strip())
            self.output_path = output
            self.started_at = datetime.now(timezone.utc).isoformat()
            return self.status()

    def stop(self) -> dict[str, Any]:
        with self._lock:
            if not self.output_path:
                return self.status()
            process = subprocess.run(
                ["logman.exe", "stop", self.SESSION_NAME, "-ets"], capture_output=True, text=True,
                timeout=20, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if process.returncode != 0:
                raise PermissionError((process.stderr or process.stdout or "Could not stop ETW recording.").strip())
            etl_path = self.output_path
            csv_path = os.path.splitext(etl_path)[0] + ".csv"
            subprocess.run(
                ["tracerpt.exe", etl_path, "-of", "CSV", "-o", csv_path, "-y"],
                capture_output=True, text=True, timeout=60,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            result = {
                "recording": False, "etl_path": etl_path,
                "csv_path": csv_path if os.path.isfile(csv_path) else None,
                "started_at": self.started_at,
            }
            self.output_path = self.started_at = None
            return result

    def status(self) -> dict[str, Any]:
        return {"recording": bool(self.output_path), "etl_path": self.output_path, "started_at": self.started_at}
