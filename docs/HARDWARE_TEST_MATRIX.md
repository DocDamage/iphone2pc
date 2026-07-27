# PocketDock 4.0 Hardware Validation Matrix

This is the release-candidate physical-device checklist. Automated source, protocol, crypto,
path-safety, and state tests do not replace these tests. Record the Windows build, iPhone/iPad
model, OS versions, router, and result for each run.

## Required release devices

- Clean Windows 10 x64 PC and clean Windows 11 x64 PC.
- At least one Lightning iPhone and one USB-C iPhone, both with Chrome installed.
- One current iPad in regular-width landscape and portrait.
- A private dual-band Wi-Fi router, a guest/isolated network, and a cellular connection.

## Connection and transport

| ID | Scenario | Expected result |
|---|---|---|
| HW-LAN-01 | Pair on the same private LAN | Full QR scan pairs once; AES-GCM status is shown; send/receive succeeds. |
| HW-LAN-02 | PC address changes after DHCP renewal | Nearby discovery resolves the saved PC and reconnects without rebroadcasting its key. |
| HW-QR-CHROME-01 | Scan the PC QR code from iPhone Chrome | Chrome companion opens; the native app can also scan the same complete QR code. |
| HW-QR-CAMERA-01 | Deny then re-enable Camera access | Clear recovery guidance appears; pairing works after enabling Camera in Settings. |
| HW-RELAY-01 | Leave Wi-Fi and use cellular relay | Saved remote connection reconnects; PC approval policy and device permissions remain enforced. |
| HW-ISOLATION-01 | Put devices on guest Wi-Fi with client isolation | Connection Doctor reports the LAN path unavailable; no false connected state. |

## Transfer durability and integrity

| ID | Scenario | Expected result |
|---|---|---|
| HW-RESUME-01 | Send a 10+ GB file, force-quit at 30–60%, reopen | Protected queue survives and resumes from the PC-acknowledged chunk offset. |
| HW-BACKGROUND-01 | Lock iPhone during a large transfer | Background URLSession continues within iOS policy; Live Activity remains accurate. |
| HW-PAUSE-01 | Pause and resume during a 4 MB chunk | The current chunk cancels safely; resume never duplicates or corrupts bytes. |
| HW-INTEGRITY-01 | Alter a staged test payload before completion | SHA-256 verification rejects it and preserves an actionable failed state. |
| HW-LOW-STORAGE-01 | Reduce PC destination below 512 MB free | Connection Doctor warns; failed transfers remain retryable. |
| HW-NETWORK-01 | Move from Wi-Fi to cellular mid-transfer | Local transfer pauses/fails clearly and remains resumable after LAN returns. |

## USB boundary

| ID | Scenario | Expected result |
|---|---|---|
| HW-USB-LAUNCH-01 | Connect an iPhone, then cold-launch PocketDock | The phone appears as detected at launch without a manual scan; Camera Roll readiness is reported separately. |
| HW-USB-DELAY-01 | Cold-launch with the iPhone connected while Windows portable-device enumeration is delayed | PocketDock retries automatically and shows the phone when Windows exposes it, without requiring a manual scan or app restart. |
| HW-USB-NO-DCIM-01 | Connect a recognized iPhone whose Internal Storage exposes neither a classic DCIM folder nor readable flattened Camera Roll buckets | PocketDock still shows the phone as detected, explains that Camera Roll is unavailable, and keeps import disabled. |
| HW-USB-DCIM-01 | Connect, unlock, and Trust an iPhone that exposes the classic Internal Storage/DCIM layout | PocketDock reports Camera Roll ready and imports the original photos/videos. |
| HW-USB-FLAT-01 | Connect, unlock, and Trust an iPhone that exposes dated Camera Roll buckets (for example, `202607_a`) directly under Internal Storage with no DCIM wrapper | PocketDock reports Camera Roll ready, enables import, and imports the original photos/videos from the flattened buckets. |
| HW-USB-LOCKED-01 | Connect a locked or untrusted iPhone | UI asks the user to unlock, keep the screen on, and tap Trust. |
| HW-USB-FILES-01 | Try to send an arbitrary Files document over the cable | UI does not claim support; it directs that workflow to LAN/relay. |
| HW-USB-PNP-01 | Connect a recognized iPhone without granting portable-storage access | Driver is green; This PC, Storage, and Camera Roll remain blocked; import stays disabled and diagnostics do not pass. |
| HW-USB-RENAME-01 | Rename the iPhone without the word “iPhone,” reconnect, unlock, and Trust | Storage-capability discovery still finds the device and enables Camera Roll import. |
| HW-USB-PARTIAL-01 | Import a set containing an existing file and interrupt one large copy | Existing file is skipped, incomplete file is removed, other items continue, and totals report new/skipped/failed accurately. |
| HW-USB-DOCUMENTS-01 | Install the signed iOS app and copy a document through Apple Devices → Files → PocketDock | Document appears in More → USB Documents and On My iPhone; Quick Look works; Send to PC requires LAN/relay. |

## Personal music recovery

| ID | Test | Expected |
| --- | --- | --- |
| HW-MUSIC-RECOVERY-01 | In the signed owner build, authorize Music with DocRoshi Beats present | Every ordered playlist entry appears in the recovery manifest; repeated entries retain their positions, while each unique eligible audio asset is exported only once. |
| HW-MUSIC-OFFLINE-01 | Launch/foreground the native app with Music authorized and no PC connection | Eligible local unprotected tracks recover into PocketDock Documents; sending waits with a visible reason instead of blocking local recovery. |
| HW-MUSIC-RECONNECT-01 | Reconnect the trusted PC after offline recovery or a paused transfer | Existing queue records resume without duplicate uploads; PC-verified delivery is recorded once and recovered files appear automatically in Windows Music Library. |
| HW-MUSIC-PROTECTED-01 | Include DRM-protected, unavailable, and non-exportable playlist entries | PocketDock never exports protected content and shows the exact per-title skip/failure reason. |
| HW-MUSIC-ORDER-01 | Compare the iPhone playlist against the saved ordered recovery manifest | Playlist name, entry count, positions, repeated members, titles, and persistent IDs match; any MediaPlayer/MusicKit count mismatch is prominently reported. |

## Apple experience

| ID | Scenario | Expected result |
|---|---|---|
| HW-LIVE-01 | Start, pause, resume, and complete a transfer | Lock Screen and Dynamic Island status changes end in Verified. |
| HW-SHORTCUT-01 | Run all three PocketDock shortcuts | Correct screen/action opens with authentication preserved. |
| HW-CONTROL-01 | Add and run the iOS 18 Control Center control | PocketDock opens and runs the configured backup. |
| HW-QUICKLOOK-01 | Preview PDF, image, video, WAV, ZIP, and unknown file | Supported types preview natively; unsupported types still offer Share/Save. |
| HW-IPAD-01 | Use iPad portrait, landscape, keyboard, and drag/drop | Sidebar/detail navigation, pointer, keyboard, Files picker, and drop targets behave natively. |
| HW-VAULT-01 | Lock/unlock and export a Mobile Vault item | Ciphertext is unreadable at rest; export requires device-owner authentication. |

## Migration, Drive, Studio, and clipboard

| ID | Scenario | Expected result |
|---|---|---|
| HW-MIGRATION-01 | Migrate an iCloud Photos library with Live Photos and albums | Originals download when available; album/year folders and final JSON report match counts. |
| HW-DRIVE-01 | Search a deep PC root, keep a file offline, then disconnect | Search remains root-confined; the pinned file opens offline through Quick Look. |
| HW-STUDIO-01 | Review a package with embedded, matched, misspelled, and missing artwork cases | Query variants/confidence are visible; verified source audio previews; approval reaches PC. |
| HW-CLIPBOARD-01 | Pin, expire, and delete text/URL/image/file handoffs | AES-GCM history orders pins first and removes expired/deleted entries on both devices. |

## Sign-off

Do not mark a public release hardware-validated until all required rows have named devices,
dates, and results. In a non-Windows/non-iOS build environment, PocketDock may report the
harness as structurally ready, but physical hardware execution must remain explicitly
“not run.”
