# PocketDock 4.0 User Guide

## Connect an iPhone

1. Open PocketDock on Windows.
2. Allow private-network access if Windows Firewall asks, or use Home → Repair Windows access.
3. Put both devices on the same trusted Wi-Fi.
4. Scan the Home QR code with Camera or the native PocketDock scanner.
5. PocketDock pairs automatically when the QR contains the code. Confirm the six-digit code only
   if it is requested.

Chrome, Safari, and other iPhone browsers provide the zero-install nearby client. PocketDock
automatically follows the iPhone’s default browser. If you mainly use Chrome, set Chrome as the
default browser in iPhone Settings, then scan the PocketDock QR with Camera; the complete nearby
client opens and pairs in Chrome. The native app adds background sessions,
Keychain, multi-PC switching, Camera Roll and contacts backup, folder sync, Share Sheet,
PocketDock Drive in Files, and remote mode.

## Transfer Center and Connection Doctor

Files selected in the native app are first copied into a protected PocketDock queue. You can
pause, resume, or retry them from **More → Transfer Center**. If iOS closes PocketDock, the queue
is recovered and resumes from the last chunk the PC acknowledged. A Live Activity shows active
progress on the Lock Screen and Dynamic Island.

Open **More → Connection Doctor** to check the trusted session, encryption, integrity, PC
destination space, active transport, Drive policy, Camera/Photos permission, and Background App
Refresh. The shareable report contains health data but no transfer key, bearer token, or file
content.

Nearby discovery can relocate a saved PC after its LAN address changes. It never broadcasts the
transfer key. A new PC must still be verified once by scanning its complete QR code.

## Music Library

PocketDock opens to **Music Library**, shows the complete index without a Show More step, and
combines four explicitly labeled sources:

1. Supported audio under Windows Music, Documents, the PocketDock incoming folder, and any music
   folders you add. These files are searchable, playable, and revealable in Explorer, and the
   local index updates while PocketDock runs. A **DocRoshi Beats** folder is prioritized at the
   top.
2. Every file staged in **On My iPhone → PocketDock**. These are real original files. In the
   native iPhone app, open **More → Music Library**, choose **Add Audio Originals or a Folder**,
   then use an individual Send action or **Send All Audio Files to PC**. Send All displays the
   count and total size for confirmation and transfers one verified file at a time.
3. Optional Music-app titles, artists, albums, durations, and ordered playlist membership. Tap
   **Allow Music Access** on the iPhone to include these rows.
4. In the owner's signed native build, locally available, unprotected, exportable Music items can
   be recovered as original audio into **On My iPhone → PocketDock → Recovered Music**. Automatic
   recovery checks every ordered member of **DocRoshi Beats** first, then the rest of the library.
   It exports each unique audio asset once, preserves playlist order in a manifest, and shows a
   named result and reason for every playlist entry. DRM is never bypassed; protected,
   unavailable, and non-exportable items stay visible instead of silently disappearing.

Enable **Share inventory with this PC** to send the encrypted inventory after native PocketDock
connects. Windows caches the latest complete manifest, so it appears at later launches even while
the phone is offline. Inventory sync itself transfers no file bytes; recovered originals use the
normal encrypted, resumable, hash-verified queue. Local recovery resumes when the native app opens
or returns to the foreground, and sending resumes when the trusted PC reconnects. iOS cannot be
woken or auto-launched by a Windows USB connection; Apple Devices can manually copy anything
already present under PocketDock's Recovered Music folder.

### Preview indexed Windows audio

Choose Play on any Windows-audio row to open the persistent preview player. The playable queue is
a snapshot of the Windows-audio rows that match the current source and search filters, in their
displayed order. You can select another queued track or remove tracks from the queue without
deleting the underlying files. Shuffle draws from the queue without repeating a track until the
available set has been used. Repeat cycles through Off, All, and One; Repeat One restarts a track
only when it reaches its natural end.

The player provides play/pause, previous and next, five-second back/forward seeking, a seek bar,
elapsed and total time, volume and mute, and playback speeds from 0.5× through 2×. It remembers its
queue and playback preferences on this PC and surfaces loading or playback errors in the player.
Where Windows exposes system media controls, PocketDock also publishes now-playing metadata and
supports the available play/pause, previous/next, seek, seek-to, and stop commands.

With focus in the player, use these shortcuts:

- `Space` — play or pause.
- `Left` / `Right` — seek back or forward five seconds.
- `Up` / `Down` — raise or lower volume by five percent.
- `M` — mute or unmute.
- `N` / `P` — next or previous. Previous restarts the current track first when it is more than
  three seconds in.
- `S` — toggle shuffle.
- `R` — cycle Repeat Off → All → One.

Shortcuts with modifier keys are ignored. PocketDock also leaves them inactive while you are
typing, moving a slider, or using another interactive control, so player shortcuts do not hijack
search or form input.

Playback is local-only and accepts only audio already present in PocketDock's Windows music index.
The desktop interface receives an opaque track identifier instead of the filesystem path, and an
unindexed path cannot be opened through the player. Phone-file and Music-app metadata rows are not
playable by themselves. After a recovered or transferred original—including a DocRoshi beat—lands
on Windows and enters the index, its Windows-audio row can be previewed. PocketDock does not infer
or promise the original iPhone playlist order from those local files; any supplied recovery
manifest remains the authority for playlist ordering.

## PocketDock Drive

1. On Windows, open **PocketDock Drive**, choose the only root iPhone may see, and enable Drive.
2. In **Settings → Trusted devices**, grant that iPhone **Browse files** and **File Provider**.
3. Connect the native app locally once, then open Files → Browse → PocketDock Drive.

Reads use encrypted chunks. Uploads use the encrypted resumable protocol. Create folders, rename
items, and move unwanted items into the recoverable `.PocketDock Archive`. Symlinks and paths
outside the approved root are rejected. Relay sessions are read-only when the PC policy is on.

Use the Drive search field to search the approved PC root. Touch and hold a file and choose
**Keep Offline** to retain an iOS-protected local copy. Offline files remain searchable and open
with native Quick Look under **More → Offline Drive**.

## File Requests

Open **File Requests**, choose a title, safe subfolder, expiration, file count, per-file limit,
and approval mode. Copy the private link or save its branded QR. Recipients need no account.
Approval-mode files remain in a private inbox until accepted; rejected staging data is removed.

## Send and receive

On iPhone, Send can select Photos, videos, Files, or a Files folder. Transfers use resumable
4 MB chunks. PocketDock does not mark a file complete until its plaintext SHA-256 matches on
both devices.

On Windows, Send to iPhone accepts the file picker, drag and drop, and Explorer’s
**Send to iPhone with PocketDock** action. Receive on iPhone decrypts and verifies before opening
the normal iOS save/share sheet in the native app or a compatible browser such as Chrome.
In PocketDock 4, native downloads open in Quick Look first, where Share, AirDrop, Save to Files,
markup, and media controls remain available.

The browser client reconstructs downloads in memory; use the native app for very large downloads
and better background reliability.

## Camera Roll backup

In the native iPhone app:

1. Open Send → Camera Roll backup.
2. Enable Automatic backup.
3. Choose whether to include only favorites, videos, and Live Photo video resources.
4. Choose charging and constrained-network safeguards.
5. Tap **Back Up New Items Now** for the first run.

iOS decides when background processing runs. Keep the PC available and grant Automatic
backup/sync permission. The PC backup window is enforced by both iPhone backup and Windows watch
folders. PocketDock pauses when schedule, charging, network, reachability, or thermal conditions
are unsuitable.

Use **Back Up Contacts as vCard** for an on-demand, complete-protection `.vcf` export sent through
the same encrypted, verified upload path.

## Restore points and retention

Recovery Center can create a restore point immediately. Scheduled backup creates at most one per
day inside the configured window. Unique contents are stored once by SHA-256; later points reuse
the object. Retention keeps recent daily versions plus the configured weekly and monthly versions.

Restore always writes into a new timestamped `PocketDock Restores` folder and never overwrites
the current copy. Every stored object is checked before restore.

## Folder sync

Create a sync profile under Windows **Sync & Backup**. Choose its PC folder, direction, deletion
policy, and optional extension filter. In the native iPhone app, open Sync, choose a Files folder,
then tap Sync Now.

Two-way sync compares SHA-256 snapshots:

- simultaneous edits preserve the iPhone version as a timestamped conflict copy;
- deletion propagation uses a recoverable PocketDock Archive when Archive is selected;
- PC-to-iPhone and iPhone-to-PC modes prevent changes in the opposite direction;
- symlinks and unsafe paths are ignored or rejected.

Review the archive before removing it permanently.

## Watch folders and Producer Studio

A Windows watch folder scans every 30 seconds:

- **Share automatically** adds new or changed matching files to the iPhone share list.
- **Producer deliveries** builds one ZIP from changed files, adds a SHA-256 metadata manifest,
  classifies beats/stems/artwork/MIDI/project files, and shares the package.

Choose an availability window on each watch folder to make automatic shares disappear after an
hour, day, week, or 30 days. No expiry keeps the existing always-available behavior.

Producer Studio creates a versioned delivery with title, artist, client, license, BPM, key, notes,
and selected files. Its private client portal records downloads and accepts approvals/revisions.

If no image is selected, PocketDock checks audio for embedded art, then searches MusicBrainz and
the Cover Art Archive using delivery metadata, tags, filenames, feature-credit variants, swapped
title order, punctuation/diacritic normalization, and typo-tolerant scoring. Confident art is
normalized into the ZIP; uncertain matches are marked for review. Discovery never blocks delivery.

The native app’s **More → Producer Studio** view shows versions, tracks, artwork confidence,
matched metadata, and every alternate or misspelled query variant tried by the matcher. When a
verified original still exists in Transfer history, tap the track for a Quick Look audio preview.
Approve the delivery or request changes with a client note from iPhone.

## Phone Migration and Mobile Vault

**More → Phone Migration** inventories Photos, video, Live Photos, albums, and contacts before
copying. The migration requests original iCloud resources, organizes them by year and album,
preserves Live Photo resources, and writes a JSON report with copied byte/resource counts and
unavailable items. Apple does not let PocketDock extract Messages, Health, Keychain passwords,
or protected app containers; the report states those boundaries explicitly.

**More → Mobile Vault** is separate from the PC passphrase vault. It uses device-owner
authentication, a device-only Keychain key, AES-GCM, and iOS complete file protection. Imports do
not upload automatically. Decrypted exports are temporary and should be shared or saved only to
a trusted destination.

## Rich clipboard

Clipboard entries can be pinned, set to expire after an hour/day/week, or deleted individually.
Text, URLs, images, and file handoffs share the encrypted history. File/image handoff sends the
actual file through the normal verified transfer queue and leaves a typed clipboard reference.

## Media gallery

Gallery groups completed transfers and shows Windows thumbnails where supported. WAV files can
display waveform samples, duration, sample rate, bit depth, and channel count. BPM and musical
key are inferred only from filename patterns unless explicitly entered in Producer Studio.

Open a completed local video in the secure Gallery viewer. Video controls
include play/pause, seeking, volume, and playback speed. Fullscreen and Picture-in-Picture are
available when supported by Windows, Chromium, and the video's format. A completed local GIF opens
as an animated image; GIFs do not expose video or audio transport controls.

Gallery playback is local-only and resolves an opaque item identifier inside the desktop process;
the media element never receives an unrestricted filesystem path. Preview is available only while the
completed item's original file still exists locally. If that file is missing or unreadable, or its
codec is unsupported, the viewer shows a clear error rather than presenting a blank preview.

## Private links

Private Links packages already shared PC files behind:

- an unguessable token;
- a separate AES key kept in the URL fragment;
- an expiration time; and
- a maximum individual-file download count.

Copy the link and send it through a trusted channel. The browser downloads encrypted chunks,
decrypts them locally, and verifies SHA-256. Revoke the link at any time. These links are served
from the PC’s local address; recipients must be able to reach that address.

Use the QR button beside an active link to show a branded delivery card. Scanning it with iPhone
Camera opens the same token- and key-bearing link without retyping it. Use **Save QR as PNG** when
you need the branded code for a delivery message, printed card, or client portal.

## Transfer Library

Transfers keeps a local, searchable history. Star important items, add up to 12 tags and a private
note, then search filenames, devices, tags, and notes together. The insight cards summarize the
last seven days, today’s activity, completion rate, and starred items. No library metadata leaves
the PC.

Smart collections provide instant views for Starred, Last 7 days, Large files, Music, and Photos.
Select one or many transfers to star them, apply a shared tag, share available files back to the
iPhone with an availability window, or add available files to the encrypted vault.

Press `Ctrl+K` anywhere in the Windows app to open the Quick Switcher. It can jump to a workspace,
start the file picker, or open the save folder. Arrow keys move through results and Enter opens the
highlighted command.

## Encrypted vault

Create a vault using a passphrase of at least 10 characters. PocketDock derives a 256-bit key
with scrypt and keeps that key only in memory while unlocked. Added files are streamed into
AES-256-GCM vault containers; exports are SHA-256 checked.

Use a unique passphrase and store it safely. PocketDock cannot recover it. Removing a vault item
permanently deletes the encrypted container.

## Remote native access

Remote mode requires:

1. a self-hosted PocketDock relay behind `wss://`;
2. the relay URL in Windows Sync & Backup;
3. the remote QR scanned by the native iPhone app; and
4. Remote access enabled for that exact trusted iPhone in Windows Settings.

Browser mode remains local-only. In 3.0, PC and iPhone exchange ephemeral X25519 public keys and derive
a fresh session secret with HKDF-SHA256. Complete request/response envelopes use AES-256-GCM. The
relay sees frame size, timing, room, and role metadata but cannot read API paths, headers, tokens,
filenames, or response status.

## Multi-PC and device permissions

The native app stores each PC’s keys and tokens in iOS Keychain. Use the computer menu to switch,
add, or forget a PC.

Windows Settings controls each iPhone independently:

- send to PC;
- receive from PC;
- clipboard;
- automatic backup/sync; and
- remote access;
- Drive browsing;
- File Provider changes; and
- File Requests.

Revoking a device invalidates trusted reconnection.

## USB import

Connect the iPhone by cable before or after opening PocketDock. Discovery starts at app launch,
retries automatically while Windows finishes enumerating a connected phone, and continues to
watch for cable changes. Open **USB Import** to view the result or run a manual rescan.
PocketDock reports four separate stages:

1. **Driver** — Windows sees Apple hardware on the cable.
2. **This PC** — Windows Shell exposes the portable-device root.
3. **Storage** — the trusted, unlocked **Internal Storage** container opens.
4. **Camera Roll** — readable media is available through either the classic
   **Internal Storage → DCIM** layout or dated buckets such as `202607_a` directly under
   **Internal Storage**; import can start.

The app still shows a phone as detected when neither supported Camera Roll layout is readable;
only four green stages enable **Import new**. A detected cable is not reported as a working
Camera Roll connection. The importer preserves the source Camera Roll bucket structure, skips existing destination files,
continues after individual copy failures, and reports imported, skipped, failed, and copied-byte
totals. Keep the iPhone unlocked and its screen on while large videos copy.

For USB transfer of files and folders, install the signed native PocketDock iOS app and open
**More → USB Documents → Add Files or Folders for USB**. The selected items are copied to
PocketDock’s USB-shared Documents folder. On Windows, choose **Open Apple Devices**, select the
iPhone, open **Files**, then choose **PocketDock** to copy every staged item in either direction.
Those items also appear in **More → USB Documents** and **On My iPhone → PocketDock**. This is
Apple File Sharing, not an automatic PocketDock connection. Apple only allows USB access to the
PocketDock shared Documents folder; no iPhone app can browse protected data belonging to other
apps or the entire device filesystem.

## Destinations and cloud folders

PocketDock has no built-in Google Drive, Dropbox, or OneDrive OAuth. You may choose:

- a normal local folder;
- a folder managed by an installed OneDrive, Dropbox, or Google Drive desktop client;
- a mapped NAS drive; or
- an available UNC path.

PocketDock writes to the Windows path. The separate sync client or network system handles the
rest and owns its credentials.

## Storage Intelligence, diagnostics, and recovery

Settings includes a live System Health Center for network status, destination write access, free
space, SQLite health, encryption, remote tunnel hardening, and trusted-device access. Run checks
again at any time or export the detailed redacted diagnostics report. Local crash reports omit
transfer keys and are pruned by the configured retention period.

Storage Intelligence groups exact SHA-256 duplicates and labels weaker same-name/size candidates.
Cleanup is review-first and uses the Windows Recycle Bin. Recovery Center checks interrupted
staging, missing destinations/history, expired shares, SQLite integrity, the background service,
and verified restore points.

## Troubleshooting

- **No QR:** Connect a network adapter, disable VPN/guest isolation, and reopen PocketDock.
- **Cannot connect locally:** Confirm trusted private Wi-Fi and that both devices can see each
  other. On Home, choose **Repair Windows access**, approve Windows, then scan the refreshed QR.
  Do not use hotel/café or guest Wi-Fi because client isolation blocks direct devices.
- **USB Driver is green but This PC is blocked:** Unlock the iPhone, tap **Trust**, keep its screen
  on, open **This PC → Apple iPhone** once in File Explorer, then scan again.
- **Storage is green but Camera Roll is blocked:** A literal DCIM wrapper is not required;
  PocketDock also supports dated Camera Roll buckets directly under Internal Storage. Confirm the
  phone contains a locally available photo or video, open Camera once, reconnect, and scan again.
  iCloud-only originals may need to download.
- **Driver is blocked:** Try another data-capable cable/USB port and install or repair
  **Apple Devices for Windows**.
- **Background backup waits:** Check charging, Low Data Mode/cellular constraints, device
  temperature, PC availability, and the PC’s per-device backup permission.
- **Remote says disabled:** Enable Remote access for that iPhone on the PC.
- **Sync needs a folder:** Re-select the Files folder; iOS may require security-scope renewal.
- **Integrity failed:** Retry on a stable link. The unverified staged file is not committed.
- **SmartScreen:** Unsigned development builds have no reputation. Public distribution should
  use the signed installer from the publisher.
