# PocketDock 4.0 Native iPhone and iPad App

The native SwiftUI project includes:

- branded app/icon assets and English/Spanish resources;
- Apple-standard NavigationStack, TabView, inset-grouped lists, system materials, semantic
  light/dark colors, Dynamic Type, VoiceOver descriptions, haptics, and reduced-motion behavior;
- explicit connecting/encrypted/unavailable states with retry and last-refresh feedback;
- an iOS-style, permission-aware, rotation-safe QR scanner with automatic code pairing;
- QR/deep-link pairing and multiple saved PCs;
- transfer secrets and tokens in iOS Keychain;
- Face ID/device-owner unlock;
- encrypted resumable upload/download and SHA-256 verification;
- protected persistent Transfer Center with pause/retry/relaunch recovery;
- incremental recovery of locally stored, unprotected Music-library audio into the USB-visible
  `Documents/Recovered Music` folder, with DocRoshi Beats processed first and automatic
  single-file encrypted delivery to the selected PC;
- Bonjour endpoint resolution for saved nearby computers and Connection Doctor;
- background URLSession transfers and BGProcessing Camera Roll backup;
- Live Activities/Dynamic Island, App Shortcuts, an iOS 18 Control Center control, and Quick Look;
- adaptive iPad sidebar/detail navigation, multiple scenes, drag/drop, and keyboard-friendly UI;
- contacts-to-vCard backup through the encrypted upload protocol;
- favorites/video/Live Photo and charging/network/thermal backup controls;
- PC-coordinated backup-window enforcement;
- security-scoped Files-folder sync with direction, conflicts, and archive deletion;
- PocketDock Drive File Provider with encrypted reads, resumable writes, and shared-Keychain
  credentials;
- Share Extension import queue;
- full Phone Migration, searchable/offline Drive, Mobile Vault, rich clipboard, Producer Studio
  review, and PC-to-iPhone sharing; and
- opt-in native WebSocket remote transport.

## Build

1. Install current Xcode and XcodeGen on macOS.
2. Run `xcodegen generate` in this directory.
3. Open `PocketDock.xcodeproj`.
4. Select the publisher’s Apple team for PocketDock, PocketDockShare, PocketDockFileProvider,
   and PocketDockWidgets.
5. In Apple Developer Certificates, Identifiers & Profiles, enable the MusicKit app service for
   the explicit `com.docdamage.pocketdock` App ID, then refresh the app provisioning profile.
   MusicKit supplies the searchable metadata inventory. MediaPlayer and AVFoundation separately
   recover items for which iOS provides an unprotected, exportable asset URL. Cloud-library
   membership alone is not an exclusion; a cloud-marked item with a usable asset URL is checked
   normally. Items with no asset URL and DRM-protected items are skipped with per-entry reasons.
6. Confirm bundle IDs, App Group, shared Keychain Group, Contacts/Photos/Music privacy
   descriptions, Background Processing capability, and permitted task ID.
7. Build and sign on a real iPhone.
8. Execute `docs/HARDWARE_TEST_MATRIX.md` from the repository root. Include background relaunch,
   Live Activity, shortcuts/control, Quick Look, iPad layouts, migration, offline Drive, Mobile
   Vault, remote permission, File Provider mutations, and Share Extension.
9. Archive and upload using the owner’s App Store Connect/TestFlight credentials.

After Music permission has been granted once, opening or foregrounding PocketDock automatically
stages eligible audio into `Documents/Recovered Music`, even when the PC is offline. The ordered
`DocRoshi Beats/playlist-manifest.json` preserves every playlist position, including repeated
entries that reference one deduplicated audio file. A connected paired PC receives pending files
through one durable, resumable transfer record. Recovery can be paused or disabled in the app.
iOS does not allow a third-party app to launch solely because a USB cable was inserted, so the app
must already be open or brought to the foreground for a new scan.

Music-library export is intended for the owner’s personal, signed build and music they own.
Apple may apply additional review-policy restrictions to a broadly distributed App Store build;
verify the current policy before distribution. PocketDock never attempts to bypass DRM or fetch
audio for which iOS does not provide a usable asset URL.

The checked-in `DEVELOPMENT_TEAM` is intentionally blank. Apple signing identities, provisioning
profiles, privacy declarations, screenshots, export compliance answers, and account ownership
must come from the publisher.

Chrome, Safari, and other iPhone browsers remain available for nearby zero-install transfers.
The Chrome companion uses the same iPhone interaction language, opens the iOS share sheet when
supported, reports offline state, and automatically pairs from the complete QR URL.
Native is recommended for large or
background work, sync, multi-PC, Keychain, and remote mode.
