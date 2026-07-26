#!/usr/bin/env python3
"""
iDrivePulse CLI Beat Extractor
CLI utility to scan connected iPhone over USB and export original beats & music to PC.
"""

import os
import sys
import argparse
import tempfile
from app import (
    IPhoneBridge,
    copy_afc_file,
    default_export_directory,
    iter_audio_scan,
    parse_audio_metadata,
    HAS_PYMOBILEDEVICE,
)

def main():
    parser = argparse.ArgumentParser(description="iDrivePulse - iPhone Beat Recovery CLI Tool")
    parser.add_argument("--output", "-o", default=default_export_directory(),
                        help="Target output directory on PC (default: ~/Music/Recovered_Beats)")
    parser.add_argument("--scan-only", "-s", action="store_true", help="Scan and list beats without exporting")
    args = parser.parse_args()

    print("=" * 65)
    print(" 🎵 iDrivePulse - iPhone Beat Recovery CLI Tool")
    print("=" * 65)

    if not HAS_PYMOBILEDEVICE:
        print("[!] Error: pymobiledevice3 library is missing.")
        sys.exit(1)

    print("[*] Connecting to iPhone over USB (usbmuxd / AFC protocol)...")
    bridge = IPhoneBridge()
    success, msg = bridge.connect(force=True)

    if not success:
        print(f"[!] {msg}")
        print("[!] Tips:")
        print("    1. Plug your iPhone into your PC via USB cable.")
        print("    2. Unlock your iPhone screen.")
        print("    3. Tap 'Trust This Computer' when prompted on your iPhone.")
        sys.exit(1)

    info = bridge.device_info
    print(f"[+] Connected to: {info.get('DeviceName', 'iPhone')} ({info.get('ProductType', 'iOS')}, {info.get('ProductVersion', '')})")
    print(f"    UDID: {info.get('UniqueDeviceID', 'N/A')}")
    print("\n[*] Scanning iPhone media storage & iTunes_Control for audio files and beats...")

    found_tracks = []
    for event, data in iter_audio_scan(device_bridge=bridge):
        if event == "scanning_root":
            print(f"    Scanning {data['root']}")
        elif event == "track_found":
            found_tracks.append(data)
        elif event == "warning":
            print(f"    [!] {data['message']}")

    print(f"\n[+] Found {len(found_tracks)} audio tracks / beats on iPhone!")

    if not found_tracks:
        print("[!] No music or audio files found in standard media directories.")
        sys.exit(0)

    print("\n--- Discovered Beats & Track Titles ---")
    for idx, tr in enumerate(found_tracks, 1):
        print(f" [{idx}] {tr['title']} | Size: {tr['filesize']} MB")
        print(f"     iOS Path: {tr['iphone_path']}")

    if args.scan_only:
        bridge.disconnect()
        sys.exit(0)

    # Export tracks
    output_dir = os.path.abspath(args.output)
    os.makedirs(output_dir, exist_ok=True)
    print(f"\n[*] Exporting {len(found_tracks)} beats to: {output_dir}")

    exported_count = 0
    for tr in found_tracks:
        stage_path = None
        try:
            stage_handle, stage_path = tempfile.mkstemp(prefix=".idrivepulse_", suffix=".transfer", dir=output_dir)
            os.close(stage_handle)
            os.remove(stage_path)
            copy_afc_file(
                tr["iphone_path"],
                stage_path,
                int(tr.get("size_bytes", 0) or 0),
                device_bridge=bridge,
            )
            metadata = parse_audio_metadata(stage_path, tr["original_filename"])
            target_path = os.path.join(output_dir, metadata["clean_filename"])
            counter = 1
            base, ext = os.path.splitext(target_path)
            while os.path.exists(target_path):
                target_path = f"{base}_{counter}{ext}"
                counter += 1

            os.replace(stage_path, target_path)
            stage_path = None
            print(f"  [✔] Exported: {os.path.basename(target_path)}")
            exported_count += 1
        except Exception as e:
            print(f"  [✘] Failed to export {tr['title']}: {e}")
        finally:
            if stage_path:
                try:
                    os.remove(stage_path)
                except FileNotFoundError:
                    pass

    print("\n" + "=" * 65)
    print(f" 🎉 SUCCESS: Recovered & exported {exported_count} beats to {output_dir}")
    print("=" * 65)
    bridge.disconnect()

if __name__ == "__main__":
    main()
