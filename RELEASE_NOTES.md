# PocketDock 4.0.1 Release Notes

PocketDock 4.0.1 repairs the Windows USB experience and removes every false claim that driver
recognition is equivalent to a working file-transfer connection.

## Fixed in 4.0.1

- Windows now opens directly to a searchable **Music Library** and automatically indexes every
  supported audio file under the current user's Music, Documents, configured incoming folder,
  and user-added music folders. The complete index is visible without pagination, refreshes while
  PocketDock runs, and keeps filesystem paths behind the desktop process.
- Indexed Windows audio now has a persistent, seekable preview player. Starting a track makes the
  currently filtered Windows-audio results the queue; phone inventory and playlist-metadata rows
  are deliberately excluded until an original file has been delivered to Windows and indexed.
  The player includes previous/next, five-second seek, a removable queue, shuffle without immediate
  repeats, Repeat All/One, volume/mute, playback speed, keyboard shortcuts, surfaced loading/error
  states, and supported Windows media controls. Local recovered DocRoshi files use the same player;
  their presence does not imply that the original iPhone playlist order was reconstructed.
- Gallery can now securely preview completed videos and animated GIFs whose original file remains
  available on this PC. Video previews provide play/pause, seeking, volume, playback speed,
  fullscreen, and Picture-in-Picture where the platform supports them. GIF previews animate
  directly and do not claim audio transport controls. Missing files, unreadable media, and codecs
  Chromium cannot decode surface an explicit preview error instead of failing silently.
- The owner's signed native iPhone app can now recover locally available, unprotected, exportable
  Music-library audio into **Recovered Music**, preserving an ordered playlist manifest and
  processing the complete **DocRoshi Beats** playlist before the rest of the library. Recovered
  originals enter the encrypted verified queue automatically when a trusted PC is connected;
  DRM-protected, unavailable, and non-exportable rows remain visible with an exact reason.
- The native app sends an encrypted complete inventory containing Music-app tracks, ordered
  playlist membership, per-item recovery results, and every file in PocketDock Documents. Windows
  caches the latest inventory per trusted phone and refreshes its received-music index as files
  arrive.
- The native Music Library can stage an audio file or folder from Files and, after confirmation,
  send every staged audio original sequentially through the resumable verified transfer queue.
- USB discovery now reports four independent capabilities: Apple driver, Windows **This PC**
  portable-device surface, unlocked **Internal Storage**, and readable **DCIM**.
- A driver-only PnP result can no longer enable import or pass the hardware harness.
- Connection Doctor shows separate Apple-driver and Camera Roll checks with the exact recovery
  action for driver, Trust, storage, DCIM, or Shell failures.
- The Camera Roll importer recognizes renamed iPhones through their storage capability, waits
  longer for large videos, sanitizes Windows filenames, continues past individual copy failures,
  and reports new, skipped, failed, and copied-byte totals.
- USB was removed from LAN/relay transport selection. Legacy **USB first** settings migrate to
  Automatic, because DCIM import is a separate capability rather than an arbitrary-file channel.
- Apple File Sharing is enabled in the native iOS target. The new **USB Documents** screen lists
  files manually staged through Apple Devices or On My iPhone and supports Quick Look, encrypted
  Send to PC, and deletion.
- The Windows USB screen can open Apple Devices and clearly identifies document staging as a
  separate manual workflow.
- Electron Builder's legacy glob consumers now use a compatibility facade over the official
  patched `brace-expansion` 5.0.8 implementation. Legacy/modern API and bounded-expansion checks
  keep the complete production and build-tool dependency audit at zero known vulnerabilities.

## New in 4.0.0

- A protected persistent Transfer Center stages user-selected files under iOS file protection,
  journals state, resumes from the PC’s acknowledged encrypted chunk offset, and supports pause,
  retry, relaunch recovery, Live Activities, and Dynamic Island progress.
- Bonjour results are resolved to real host/port endpoints and reconnect previously trusted
  computers without advertising transfer keys. New computers still require one full QR scan.
- Connection Doctor combines authenticated PC transport, storage, encryption, integrity, Drive,
  and permission checks with iPhone Camera, Photos, and background-refresh checks; its JSON report
  is redacted and shareable.
- App Shortcuts cover Send, Back Up Now, and Connection Doctor. iOS 18 adds a Control Center backup
  control, and multi-scene support is enabled.
- iPad gains adaptive sidebar/detail navigation; iPhone keeps a focused five-tab layout with an
  expanded More area. Drag/drop, native Files pickers, Quick Look, Dynamic Type, pointer behavior,
  and system materials carry the native Apple experience throughout.
- Full Phone Migration inventories and preserves original photos, video, Live Photo resources,
  album/year organization, and contacts, then uploads a JSON report that explicitly records
  unavailable iCloud resources and Apple-controlled data boundaries.
- PocketDock Drive adds approved-root recursive search, encrypted offline pinning, offline search,
  and native Quick Look.
- Mobile Vault adds Face ID/device-owner gating, a device-only Keychain master key, AES-GCM
  ciphertext, and complete iOS file protection.
- Producer Studio on iPhone now exposes versions, tracks, metadata, artwork confidence, the exact
  alternate/misspelled search variants used by the matcher, verified source audio previews,
  approvals, revision requests, and client notes.
- Clipboard history now supports pinned and expiring entries, per-entry deletion, and text, URL,
  image, and file handoff types while keeping payloads encrypted.
- A hardware-readiness harness and explicit Windows/iPhone/iPad test matrix cover LAN, Chrome QR,
  USB DCIM, relay, backgrounding, large-file resume, Apple integrations, migration, Studio, Drive,
  Vault, and clipboard. Physical execution remains a release sign-off step.
- USB wording is now deliberately precise: Windows can import exposed DCIM photos/video over a
  trusted cable; arbitrary Files documents still use LAN or the optional relay.

## New in 3.1.0

- The native SwiftUI app now uses Apple-standard large-title navigation, inset-grouped lists,
  semantic light/dark colors, system tab bars, materials, confirmation dialogs, content-unavailable
  states, contextual menus, Dynamic Type, and minimum 44-point controls.
- Connection health is now first-class: connecting, encrypted, unavailable, retry, last-refresh,
  offline, and transfer states are visible without exposing technical noise.
- QR scans containing the PocketDock code now pair automatically. The scanner has an iOS-style
  framing guide, a clear dismissal control, rotation-safe camera layout, and a direct Settings
  recovery path when Camera access is denied.
- Successful connections, transfers, tab selections, copy actions, and errors provide restrained
  system haptic feedback, with reduced-motion preferences respected.
- Downloads in the native app and compatible iPhone browsers now open the normal iOS share sheet
  after decryption and verification, with Save to Files as the fallback.
- The Chrome companion is rebuilt as an iPhone-first experience with a safe-area-aware bottom tab
  bar, translucent navigation surfaces, Apple system typography, semantic grouped backgrounds,
  native control sizing, persistent tab selection, keyboard-accessible tabs, and clear offline
  recovery.
- Chrome remains fully supported for QR auto-pairing, AES-256-GCM transfers, Photos and Files
  picking, folders, clipboard, resumable transfer controls, receiving, and private links.
- File Requests and private Producer links use the same semantic iPhone design system and
  accessible live status messaging.
- Automated coverage now verifies the Apple-native navigation, accessibility, safe-area,
  dark-mode, reduced-motion, native sharing, network-state, QR, and SwiftUI behavior.

## Fixed in 3.0.2

- QR pairing now prefers the real Wi-Fi adapter instead of WSL, Docker, Hyper-V, VPN, or other
  virtual adapters.
- The Chrome/Safari transfer page now includes a portable AES-256-GCM implementation for local
  HTTP, where iOS does not expose WebCrypto. Encryption remains enabled and wire-compatible.
- Browser detection labels trusted devices correctly when Chrome, Edge, Firefox, or Safari is
  used on iPhone.
- The native iPhone app probes the PC before pairing and reports an actionable network/firewall
  error instead of waiting silently.
- USB discovery now checks Windows Portable Devices directly, recognizes custom iPhone names,
  distinguishes a locked phone from a missing phone, and verifies copies finish before reporting
  success.
- Windows installs create a private-network, program-scoped firewall rule. Portable builds expose
  a “Repair Windows access” action that creates the same rule with approval.

## New in 3.0

- PocketDock Drive, including a native iOS File Provider and approved-root PC browser.
- Account-free, expiring File Requests with bounded uploads, branded QR export, and approval inbox.
- Content-addressed restore points with SHA-256 verification, deduplication, safe restore folders,
  backup windows, and daily/weekly/monthly retention.
- Storage Intelligence duplicate review and a first-class Recovery Center.
- Native contacts-to-vCard backup and PC-coordinated Camera Roll scheduling.
- Windows background Task Scheduler integration, automatic clipboard mode, and configurable
  LAN/USB/relay transport preference.
- Producer client portals with versions, licenses, tracks, download counts, approval/revision
  status, and client notes.
- Automatic album art from selected images, embedded audio artwork, or the Cover Art Archive.
  Search normalizes punctuation, accents, feature credits, release suffixes, swapped title order,
  filenames, and misspellings; lower-confidence matches are marked for review.
- X25519 ephemeral remote sessions, HKDF-SHA256 keys, AES-256-GCM envelopes, direction binding,
  per-device authorization, and replay rejection.
- A complete visual redesign with responsive layouts, three density modes, scalable UI, high
  contrast, light/dark/system themes, keyboard navigation, and reduced-motion support.
- Expanded automated coverage for art matching, restore points, File Requests, encrypted
  transfers, sync, vault, replay protection, storage, and permissions.

## Source repository

The repository contains desktop, iOS, and relay source; Windows helper and packaging scripts;
project files; documentation; tests; dependency locks; and all 48 supplied branding-pack files.
Generated desktop bundles, installers, portable executables, package archives, and user media are
intentionally not tracked.

## Intentional exclusions and signing boundary

There is no built-in Google Drive, Dropbox, or OneDrive OAuth. Synced desktop folders and mounted
network storage remain supported as ordinary Windows paths.

Windows and Apple signatures cannot be fabricated. Public release still requires the owner’s
Windows certificate, Apple team, provisioning profiles, App Store Connect access, and final
Windows/iPhone hardware smoke tests.
