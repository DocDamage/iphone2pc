# PocketDock 4.0

PocketDock is a private file bridge for iPhone and Windows. It moves original-quality files,
photos, videos, folders, clipboard text, music projects, and encrypted deliveries directly to
your PC, with local-first defaults and no PocketDock account.

## What is included

- Branded Windows 10/11 desktop app with light, dark, and system themes
- Native-feeling local Chrome/Safari companion and installable Home Screen web app with automatic
  QR pairing, safe-area tab navigation, semantic light/dark appearance, native sharing, and
  offline recovery
- Apple-native SwiftUI iPhone and iPad app with adaptive sidebar/tab navigation, semantic colors,
  Dynamic Type, haptics, multi-PC switching, Keychain credentials, Share Extension, widgets,
  Live Activities/Dynamic Island, App Shortcuts, a Control Center action, Face ID/device unlock,
  Quick Look, drag/drop, background transfers, Camera Roll and contacts backup, folder sync,
  and a PocketDock Drive File Provider
- Persistent protected Transfer Center with pause, retry, crash/relaunch recovery, resumable
  PC-acknowledged offsets, transfer speeds, haptics, and lock-screen progress
- AirDrop-style nearby Bonjour discovery for previously trusted computers without broadcasting
  transfer keys, plus a redacted, exportable iPhone/PC Connection Doctor
- Full Phone Migration for original Photos/video/Live Photo resources, album/year organization,
  contacts, iCloud-original requests, progress, and a machine-readable completion report
- Searchable PocketDock Drive with native Quick Look and encrypted offline files
- Face ID-gated, AES-GCM on-device Mobile Vault
- iPhone Producer Studio with delivery metadata, artwork confidence and alternate/misspelled query
  review, verified audio previews, client notes, approvals, and change requests
- Rich encrypted clipboard history with pins, expiration, deletion, URL, image, and file handoffs
- Local Wi-Fi, capability-verified Windows USB Camera Roll import, manual Apple Devices document
  staging, and a content-blind native remote relay tunnel
- Complete launch-time Windows music indexing across Music, Documents, PocketDock Received, and
  user-added folders, with full-library search and DocRoshi Beats priority
- Secure local audio previews for indexed Windows tracks, with a persistent queue, seek and
  transport controls, shuffle/repeat, volume, playback speed, keyboard shortcuts, and supported
  Windows media controls; recovered DocRoshi originals can be previewed as soon as they are local
  and indexed
- Personal signed-build recovery of locally available, unprotected, exportable iPhone Music audio,
  including ordered whole-playlist manifests, per-title reasons, and automatic verified delivery
- AES-256-GCM transfer chunks and SHA-256 end-to-end file verification
- Resumable transfers, retries, pause/resume/cancel, bandwidth limits, speed, and ETA
- Per-iPhone permissions for send, receive, clipboard, automatic backup/sync, remote access,
  Drive browsing, File Provider changes, and File Requests
- PocketDock Drive: a user-approved PC root inside the iPhone Files app
- Account-free, bounded, expiring File Requests with branded QR codes and a PC approval inbox
- Recoverable two-way folder sync with direction filters and conflict copies
- Scheduled PC/iPhone backups, deduplicated restore points, and daily/weekly/monthly retention
- PC watch folders with backup-window enforcement and automatic Producer Delivery packages
- Encrypted expiring private links with download limits and fragment-held decryption keys
- Branded private-link QR cards for one-scan delivery from an iPhone
- Local Transfer Library with multi-select actions, smart collections, favorites, tags, private
  notes, full-text filters, and activity insights
- Time-limited watch-folder shares that automatically disappear after a chosen window
- Passphrase-protected AES-256-GCM vault with scrypt key derivation and auto-lock
- Media gallery with secure local previews for completed videos and animated GIFs, Windows
  thumbnails, WAV waveform/format analysis, and filename BPM/key hints
- Producer Studio client portals, versions, licenses, tracks, approvals/revisions, download
  tracking, metadata, and SHA-256 manifests
- Automatic artwork from selected images, embedded audio art, or typo-tolerant
  MusicBrainz/Cover Art Archive matching across tags, filenames, and alternate title spellings
- Storage Intelligence duplicate review and a Recovery Center with verified restore
- SQLite WAL persistence, pre-2.5 database backup, crash-safe staging, diagnostics, and local
  crash reports
- Explorer integration, tray mode, Windows startup, notifications, Jump List, firewall helper,
  and update-channel plumbing
- Three interface densities, 85–125% scaling, high contrast, responsive layouts, light/dark/system
  themes, English/Spanish foundations, and reduced-motion support
- Live System Health Center with at-a-glance checks and exportable redacted diagnostics
- Keyboard-operated quick switcher (`Ctrl+K`), clearer focus states, responsive controls, and
  reduced-motion support
- Official PocketDock branding pack, product icons, app marks, and production assets

PocketDock deliberately has no built-in Google Drive, Dropbox, or OneDrive OAuth. You can still
choose a folder managed by an installed desktop sync client or a mounted NAS; PocketDock only
writes to that ordinary Windows path and never receives the cloud account credentials.

## Quick start

1. Start PocketDock from this source checkout with `npm ci` and `npm run dev`, or use a separately
   supplied signed Windows build.
2. Allow private-network access if Windows Firewall asks.
3. Open Home and scan the QR code from the iPhone.
4. Choose Photos or Files and send.

If Chrome is your default iPhone browser, the PC QR opens PocketDock in Chrome and pairs
automatically. Chrome supports the complete nearby transfer, receive, and clipboard workflow.

Files default to `Downloads\PocketDock`. The native iPhone app is recommended for background
transfers, Camera Roll and contacts backup, PocketDock Drive, folder sync, multi-PC use, and
remote access. Chrome, Safari, and other iPhone browsers remain the zero-install option for
nearby transfers and File Requests.

## Build and verify

From the repository root on Windows with Node.js 22 or newer, these commands verify the source
without creating installers or release archives:

```powershell
npm ci
npm run verify
npm run verify:ios
npm run verify:hardware
npm run verify:relay
npm --prefix relay test
npm run verify:build-tools
```

For a separate local installer build, run `BUILD_WINDOWS_INSTALLER.bat`. Generated packages stay
under the ignored `release` directory and should be signed with the publisher’s real Windows
code-signing identity before public distribution.

For the native iPhone project, use current Xcode and XcodeGen on macOS:

```bash
cd ios
xcodegen generate
open PocketDock.xcodeproj
```

Select the publisher’s Apple Development team for all four targets, confirm the App and Keychain
Groups, build on
a real iPhone, then archive for TestFlight. Signing identities and App Store credentials are not
included in source.

## Documentation

- [User guide](docs/USER_GUIDE.md)
- [Security model](docs/SECURITY.md)
- [Technical guide](docs/TECHNICAL_GUIDE.md)
- [Hardware validation matrix](docs/HARDWARE_TEST_MATRIX.md)
- [Brand asset guide](branding/PocketDock_Branding_Pack/README.txt)
- [Native iPhone notes](ios/README.md)
- [Private relay deployment](relay/README.md)

PocketDock is private software created for DocDamage. Redistribution rights are not granted.
