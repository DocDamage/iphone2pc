"""Windows WinFsp mount lifecycle and hardware discovery."""

from app_core import *
from app_device import *

def run_powershell_json(script: str):
    """Run a fixed, read-only PowerShell inventory script and decode its JSON."""
    if sys.platform != "win32":
        return []
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    completed = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        timeout=12,
        creationflags=creation_flags,
        check=False,
    )
    if completed.returncode != 0 or not completed.stdout.strip():
        return []
    try:
        result = json.loads(completed.stdout)
        return result if isinstance(result, list) else [result]
    except ValueError:
        return []


def port_is_open(host: str, port: int, timeout: float = 0.15) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def normalize_mount_drive(value: str) -> str:
    value = (value or "").strip().upper()
    if len(value) == 1 and "D" <= value <= "Z":
        value += ":"
    if len(value) != 2 or value[1] != ":" or not ("D" <= value[0] <= "Z"):
        raise ValueError("Choose an unused drive letter from D: through Z:.")
    return value


def winfsp_available() -> bool:
    return (
        sys.platform == "win32"
        and os.path.isdir(r"C:\Program Files (x86)\WinFsp")
        and importlib.util.find_spec("winfspy") is not None
    )


def get_mount_status() -> dict:
    global MOUNT_PROCESS, MOUNT_DRIVE, MOUNT_STOP_FILE, MOUNT_LOG_PATH
    with MOUNT_LOCK:
        running = MOUNT_PROCESS is not None and MOUNT_PROCESS.poll() is None
        if MOUNT_PROCESS is not None and not running:
            MOUNT_PROCESS = None
        mounted = bool(running and MOUNT_DRIVE and os.path.exists(f"{MOUNT_DRIVE}\\"))
        return {
            "available": winfsp_available(),
            "running": running,
            "mounted": mounted,
            "drive": MOUNT_DRIVE,
            "mode": "AFC tree read-only; Portable Files read/write",
            "log": MOUNT_LOG_PATH if MOUNT_LOG_PATH and os.path.isfile(MOUNT_LOG_PATH) else None,
        }


def start_mount_process(drive: str) -> dict:
    global MOUNT_PROCESS, MOUNT_DRIVE, MOUNT_STOP_FILE, MOUNT_LOG_PATH
    drive = normalize_mount_drive(drive)
    if not winfsp_available():
        raise RuntimeError("WinFsp and its Python binding are not installed.")
    if os.path.exists(f"{drive}\\"):
        raise FileExistsError(f"{drive} is already in use.")

    with MOUNT_LOCK:
        current = get_mount_status()
        if current["running"]:
            if current["drive"] == drive:
                return current
            raise RuntimeError(f"The iPhone is already mounted at {current['drive']}.")

        MOUNT_DRIVE = drive
        MOUNT_STOP_FILE = os.path.join(TEMP_CACHE_DIR, "mount.stop")
        MOUNT_LOG_PATH = os.path.join(TEMP_CACHE_DIR, "mount.log")
        try:
            os.remove(MOUNT_STOP_FILE)
        except FileNotFoundError:
            pass
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        with open(MOUNT_LOG_PATH, "w", encoding="utf-8") as log:
            MOUNT_PROCESS = subprocess.Popen(
                [
                    sys.executable,
                    os.path.join(BASE_DIR, "iphone_mount.py"),
                    "--mount",
                    drive,
                    "--stop-file",
                    MOUNT_STOP_FILE,
                ],
                cwd=BASE_DIR,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                creationflags=creation_flags,
            )

    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if MOUNT_PROCESS.poll() is not None:
            break
        if os.path.exists(f"{drive}\\"):
            return get_mount_status()
        time.sleep(0.2)

    status = get_mount_status()
    if status["mounted"]:
        return status
    error = "The mount process did not become ready."
    try:
        with open(MOUNT_LOG_PATH, "r", encoding="utf-8") as source:
            lines = source.read().strip().splitlines()
        if lines:
            error = lines[-1][:500]
    except OSError:
        pass
    stop_mount_process()
    raise RuntimeError(error)


def stop_mount_process() -> dict:
    global MOUNT_PROCESS, MOUNT_DRIVE, MOUNT_STOP_FILE
    with MOUNT_LOCK:
        process = MOUNT_PROCESS
        stop_file = MOUNT_STOP_FILE
    if process is not None and process.poll() is None:
        if stop_file:
            with open(stop_file, "w", encoding="utf-8") as output:
                output.write("stop\n")
        try:
            process.wait(timeout=12)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
    with MOUNT_LOCK:
        MOUNT_PROCESS = None
        MOUNT_DRIVE = None
        MOUNT_STOP_FILE = None
    return get_mount_status()


atexit.register(stop_mount_process)


def windows_hardware_diagnostics() -> dict:
    pnp_devices = run_powershell_json(
        "$items = Get-CimInstance Win32_PnPEntity | Where-Object { "
        "$_.Name -like '*Apple Mobile Device*' -or $_.Name -like '*Apple iPhone*' -or "
        "$_.Name -like '*Apple USB*' -or $_.PNPDeviceID -like 'USB\\VID_05AC*' }; "
        "$items | Select-Object Name,Status,Service,PNPClass,ConfigManagerErrorCode | ConvertTo-Json -Compress"
    )
    signed_drivers = run_powershell_json(
        "$items = Get-CimInstance Win32_PnPSignedDriver | Where-Object { "
        "$_.DeviceName -like '*Apple Mobile Device*' -or $_.DeviceName -like '*Apple iPhone*' -or "
        "$_.DeviceName -like '*Apple USB*' }; "
        "$items | Select-Object DeviceName,DriverVersion,Manufacturer,IsSigned,Signer | ConvertTo-Json -Compress"
    )
    apple_services = run_powershell_json(
        "$items = Get-CimInstance Win32_Service | Where-Object { "
        "$_.Name -like '*Apple*' -or $_.DisplayName -like '*Apple Mobile Device*' }; "
        "$items | Select-Object Name,DisplayName,State,StartMode | ConvertTo-Json -Compress"
    )
    apple_processes = run_powershell_json(
        "$names = 'AppleMobileDeviceProcess','AppleMobileDeviceHelper','iTunes'; "
        "$items = Get-Process -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.ProcessName }; "
        "$items | Select-Object ProcessName,Id | ConvertTo-Json -Compress"
    )
    winfsp_path = r"C:\Program Files (x86)\WinFsp"
    winfsp_installed = os.path.isdir(winfsp_path)
    try:
        is_admin = bool(ctypes.windll.shell32.IsUserAnAdmin()) if sys.platform == "win32" else False
    except Exception:
        is_admin = False

    pnp_present = bool(pnp_devices)
    mux_ready = port_is_open("127.0.0.1", 27015)
    afc_ready = bridge.probe() if bridge.connected else False
    if afc_ready:
        state = "AFC_READY"
    elif mux_ready and pnp_present:
        state = "MUX_READY"
    elif pnp_present:
        state = "ENUMERATED"
    else:
        state = "ABSENT"

    return {
        "state": state,
        "pnp_present": pnp_present,
        "mux_ready": mux_ready,
        "afc_ready": afc_ready,
        "admin": is_admin,
        "pnp_devices": pnp_devices,
        "signed_drivers": signed_drivers,
        "apple_services": apple_services,
        "apple_processes": apple_processes,
        "winfsp_installed": winfsp_installed,
        "mount": get_mount_status(),
        "portable_files_root": PORTABLE_FILES_ROOT,
        "access": {
            "current": "AFC media root (/var/mobile/Media)",
            "iphone_kernel_or_root": False,
            "explanation": "Stock iOS exposes the trusted AFC media service, not the iOS root filesystem.",
        },
    }
