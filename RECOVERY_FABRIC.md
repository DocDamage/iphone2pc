# iDrivePulse Recovery Fabric Capability Contract

## Capability

iDrivePulse turns a trusted iPhone, Apple Devices backups, the optional companion
container, and verified PC copies into one local recovery fabric. A user can discover,
preview, select, resume, verify, organize, and prove the provenance of their own files
without changing the source or uploading content.

## Fixed constraints

- Stock-iOS trust, encryption, code-signing, app-sandbox, and DRM boundaries remain intact.
- Phone mutations remain confined to the dedicated Portable Files container.
- Recovery is selection-driven. Importing a backup does not automatically extract it.
- Original recovered bytes are immutable. AI outputs, clean names, and provenance are sidecars.
- Every published copy has a byte count and SHA-256 verification result.
- Passwords, backup secrets, and vault passphrases are never persisted in plaintext.
- Windows 10 remains the baseline. Windows 11 ML and placeholder capabilities are detected.
- All network listeners are disabled by default and require explicit authenticated pairing.

## Actors and surfaces

- **Owner:** chooses sources, assets, destinations, cache policy, and destructive operations.
- **Local UI/API:** unprivileged orchestration bound to loopback.
- **Device service:** observes PnP events and resumes already-authorized work.
- **Recovery workers:** read sources, populate chunks, verify outputs, and record reports.
- **iOS companion:** exposes only its own Documents/File Provider container.

## Lifecycle

`disconnected -> detected -> trusted -> indexed -> requested -> hydrating -> recovering -> verified -> mirrored -> signed`

Any active state may move to `interrupted`; reconnecting the same pseudonymous device may
move it back to the prior resumable state. Verification failure never publishes a final file.

## Interfaces and data

- A unified asset record includes source kind, source locator, pseudonymous device or backup
  identifier, size, timestamps, metadata, content hash, chunk manifest, recovery state, and
  optional project/version relationships.
- A content manifest lists ordered chunk hashes and sizes plus an overall SHA-256 and Merkle root.
- Provenance packages bind immutable recovery facts and ingredients to an owner-controlled key.
- Device events and cable samples are timestamped, bounded, and redact raw device identifiers.

## Non-goals

- Jailbreak, exploit, passcode, Activation Lock, encryption, or DRM bypass.
- Reading arbitrary private app sandboxes from a stock device.
- A Windows kernel filter that claims to grant additional iOS privileges.
- Silent extraction of all personal data from backups.
- Cloud-hosted AI or mandatory user accounts.

## Architecture defaults

- 20 GiB default hydration-cache quota, configurable by environment or UI.
- Backup browsing is audio/project focused until the owner explicitly enables all-file browsing.
- Local signal features are always available; hardware-accelerated model providers are optional.
- Provenance uses a protected local Ed25519 key and can be upgraded to C2PA/X.509 signing.
- Native PnP notification is preferred, with bounded polling as a portable fallback.

## Open deployment decisions

- A Mac, signing team, and suitable entitlements are required to ship the File Provider extension.
- Trusted public C2PA signing requires an owner-selected certificate or identity provider.
- Encrypted Apple backups require the owner-provided password and a compatible decryption backend.
- Wireless companion access requires an explicit pairing ceremony and LAN exposure opt-in.

## Delivery contract

Each feature ships behind capability detection, retains existing AFC recovery behavior, has a
testable service boundary, and reports `available`, `degraded`, or `unavailable` with a reason.
