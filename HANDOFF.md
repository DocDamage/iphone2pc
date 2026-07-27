# PocketDock 4.0.1 Handoff

## Implementation status

Implemented:

- production-ready Electron renderer/main/preload source;
- Apple-native local Chrome/Safari PWA client and private-link page with bottom tab navigation,
  safe areas, semantic appearance, native sharing, and offline recovery;
- native SwiftUI iPhone source with system navigation and controls, explicit connection health,
  automatic QR pairing, permission-aware scanning, haptics, Keychain, multi-PC, background
  transfer, Camera Roll and contacts backup, folder sync, remote transport, Share Extension,
  and File Provider;
- operational PC remote bridge plus Docker-ready two-peer relay;
- X25519/HKDF forward-secret remote sessions and AES-256-GCM envelopes with downgrade rejection;
- sync profiles, watch folders, Producer Studio, gallery, private links, vault, diagnostics,
  firewall helper, recovery backup, localization foundations, and per-device permissions.
- local Transfer Library favorites/tags/notes/insights, private-link QR cards, expiring automatic
  shares, and the `Ctrl+K` Quick Switcher.
- PocketDock Drive, account-free File Requests, deduplicated restore points, storage intelligence,
  encrypted replay protection, smart collections, QR exports, and live System Health.
- Producer client portals plus embedded and typo-tolerant online album-art recovery.
- durable protected iOS transfer queue, nearby endpoint resolution, Connection Doctor, native
  Quick Look, Live Activities/Dynamic Island, App Shortcuts, iOS 18 Control Center control,
  multi-scene iPad navigation, Phone Migration, offline Drive, Mobile Vault, rich clipboard,
  and mobile Producer Studio.
- capability-based Windows USB diagnosis and resilient DCIM import, plus separately labeled
  Apple File Sharing document staging with a native iPhone USB Documents screen.
- encrypted per-device iPhone Music/PocketDock Documents inventories, cached Windows library
  browsing, explicit Music consent, ordered whole-playlist manifests, and incremental recovery of
  locally available unprotected originals through the sequential verified transfer queue.

Verified in this environment:

- strict desktop TypeScript;
- unit and real HTTP integration suites, including Apple-native iPhone behavior, remote-envelope
  tamper/direction/replay, File Request, restore, artwork, and share-integrity checks;
- complete production and development/build-tool dependency audit with zero known vulnerabilities;
- renderer and Electron production builds, with generated output intentionally omitted from Git;
- relay TypeScript;
- iOS source/property-list/project structure;
- branding checksums and app-icon opacity.

The iOS target cannot be compiled or signed outside macOS/Xcode. A Windows installer can be
packaged here, but publisher signing requires the real certificate.

This repository intentionally tracks source and required runtime/packaging assets only. Compiled
application output, installers, portable executables, archives, and user media are excluded.

## Before public release

1. Build and smoke-test the NSIS installer on clean Windows 10 and 11 machines.
2. Sign the executable, installer, and update metadata with the publisher’s certificate.
3. Enable the MusicKit App Service for the explicit `com.docdamage.pocketdock` App ID, generate
   the Xcode project, set the Apple team for all four targets, confirm the App and Keychain
   Groups, and compile under current Xcode with Swift 6 checks.
4. Execute every required row in `docs/HARDWARE_TEST_MATRIX.md` on clean Windows 10/11 PCs,
   Lightning and USB-C iPhones, and iPad. The current environment verifies the harness but cannot
   claim physical hardware execution.
5. Deploy the relay behind `wss://`, redact query strings, restrict logs, and set rate/room limits.
6. Enable remote access only for the intended iPhone in Windows Settings.
7. Archive and upload the iOS app through the owner’s TestFlight/App Store Connect account.
8. Configure an HTTPS signed update feed only after signed Windows artifacts exist.

## Product boundaries

- iOS exposes user-selected Photos/Files data, not unrestricted app-private storage.
- Automated USB mode reads Windows’ exposed DCIM Camera Roll only. The native iOS app also exposes
  its Documents container through Apple Devices for manual, user-controlled file staging.
- PocketDock Documents contain transferable originals. In the owner's signed native build,
  MediaPlayer and AVFoundation can recover only Music items for which iOS supplies a local,
  unprotected, exportable asset. DRM-protected and unavailable items are never bypassed and remain
  inventory rows with a reason. iOS cannot launch PocketDock merely because a USB cable was
  connected; local recovery resumes when the native app launches or returns to the foreground,
  and encrypted sending resumes when a trusted PC is connected.
- The local browser HTTP bootstrap is trust-on-first-use; use it only on trusted private Wi-Fi.
- Remote application envelopes are content-blind to the relay, but the service still observes
  room/role, connection timing, and frame sizes. Query-string redaction and the security guide
  remain mandatory.
- Background execution is scheduled by iOS and is not guaranteed to run at an exact time.
- No Google Drive, Dropbox, or OneDrive OAuth is embedded. Desktop sync-client folders work as
  ordinary destinations without giving PocketDock those credentials.
