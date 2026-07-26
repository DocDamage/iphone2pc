"""Command-line entry point for the iDrivePulse virtual drive."""

from iphone_mount_operations import *


def create_iphone_file_system(mountpoint: str, bridge: IPhoneBridge, cache_dir: str) -> FileSystem:
    mountpoint = validate_mountpoint(mountpoint)
    operations = IPhoneFileSystemOperations(bridge, cache_dir)
    serial_source = str(bridge.device_info.get("UniqueDeviceID", "iDrivePulse"))
    serial = int(hashlib.sha256(serial_source.encode("utf-8")).hexdigest()[:8], 16)
    return FileSystem(
        mountpoint,
        operations,
        sector_size=512,
        sectors_per_allocation_unit=8,
        volume_creation_time=filetime_now(),
        volume_serial_number=serial,
        file_info_timeout=750,
        case_sensitive_search=1,
        case_preserved_names=1,
        unicode_on_disk=1,
        persistent_acls=0,
        post_cleanup_when_modified_only=1,
        um_file_context_is_user_context2=1,
        file_system_name="iDrivePulse",
        read_only_volume=0,
    )


def main():
    parser = argparse.ArgumentParser(description="Mount the AFC-visible iPhone media root as a Windows drive.")
    parser.add_argument("--mount", default="I:", help="Unused drive letter, for example I:")
    parser.add_argument("--stop-file", help="Private signal file used by the parent app for a clean unmount.")
    args = parser.parse_args()
    mountpoint = validate_mountpoint(args.mount)
    if os.path.exists(f"{mountpoint}\\"):
        raise SystemExit(f"{mountpoint} is already in use.")

    bridge = IPhoneBridge()
    connected, message = bridge.connect(force=True)
    if not connected:
        raise SystemExit(message)
    if not bridge.afc.exists(PORTABLE_FILES_ROOT):
        bridge.afc.makedirs(PORTABLE_FILES_ROOT)

    cache_dir = tempfile.mkdtemp(prefix="idrivepulse-mount-")
    atexit.register(lambda: shutil.rmtree(cache_dir, ignore_errors=True))
    file_system = create_iphone_file_system(mountpoint, bridge, cache_dir)
    stop_event = threading.Event()

    def request_stop(signum=None, frame=None):
        stop_event.set()

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    try:
        file_system.start()
        print(f"MOUNT_READY {mountpoint}", flush=True)
        while not stop_event.wait(0.5):
            if args.stop_file and os.path.exists(args.stop_file):
                break
            time.sleep(0)
    finally:
        file_system.stop()
        bridge.disconnect()


if __name__ == "__main__":
    main()
