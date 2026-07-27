# PocketDock 4.0 Security Model

## Pairing and device trust

The PC creates a rotating six-digit PIN and a persistent random 256-bit transfer secret. The QR
puts the transfer secret in the URL fragment, which browsers do not send as an HTTP request.
Successful pairing returns a short-lived session token and a separate refresh token. SQLite
stores only the refresh-token SHA-256 hash. Devices can be revoked or restricted individually.

Native iOS connection metadata is kept in UserDefaults while transfer keys and tokens are stored
in Keychain using `AfterFirstUnlockThisDeviceOnly`.

## File and clipboard encryption

File and clipboard bodies use AES-256-GCM. Each chunk has a new random 96-bit nonce. Additional
authenticated data binds the transfer/file identifier, offset, and plaintext length, so modified,
reordered, truncated, or replayed chunks fail authentication.

The sender and receiver independently compute SHA-256 over complete plaintext. A received file is
not finalized until hashes match.

## Vault

The vault derives a 256-bit key with scrypt (`N=32768`, `r=8`, `p=1`) and a random salt. A keyed
check validates unlock attempts without storing the passphrase or key. Each vault item uses a new
AES-256-GCM nonce and authenticates its ID, name, and size. The in-memory key is zeroed on lock
and auto-lock. Exported plaintext is SHA-256 verified.

There is no recovery key. Losing the passphrase loses access.

The native Mobile Vault is independent. It uses a random 256-bit device-only Keychain key,
AES-256-GCM sealed containers, complete iOS file protection, and device-owner authentication in
the app. Mobile Vault items never upload automatically. Exported plaintext is temporary and
inherits iOS file protection.

## Private links

Private-link tokens and AES keys are independently HMAC-derived from the PC transfer secret and
link ID. The server stores a token hash. Token and key stay in the URL fragment used by the share
page. Chunks are AES-256-GCM encrypted with the per-link key and verified in the recipient browser.
Expiration, revocation, and download caps are server-enforced.

The page is served from the local PC and shares the browser bootstrap limitation below. Anyone who
possesses the complete link and can reach the PC can use it until it expires, reaches its limit,
or is revoked.

## Local browser trust-on-first-use limitation

The local Chrome/Safari companion is initially delivered over local HTTP. PocketDock encryption protects
payloads after the expected code is running, but an active attacker already controlling the LAN
could replace the bootstrap page before encryption begins.

Use browser mode only on trusted private Wi-Fi. The separately installed, signed native iPhone app
has a stronger code boundary.

## Native remote mode

Remote mode is off by default, native-app-only, and separately permissioned per trusted iPhone.
The PC adds an internal marker to relayed requests; the local API rejects that marker unless the
device’s Remote access permission is enabled.

PocketDock exchanges ephemeral X25519 public keys and derives a fresh session secret with
HKDF-SHA256, salted by the paired transfer secret. It encrypts complete request/response envelopes
with AES-256-GCM. Direction labels are authenticated, old tunnel versions are rejected, and a
bounded replay guard drops malformed/repeated IDs before the API. The relay cannot read API
paths, headers, tokens, filenames, JSON bodies, status codes, or response content.

The relay still observes connection timing, frame sizes, PC/iPhone roles, room ID, and the room
secret in the WebSocket URL. This metadata is sufficient for traffic analysis, so the relay is
content-blind rather than anonymous.

Production relay requirements:

- `wss://` with a valid certificate;
- query-string redaction in access/error/analytics logs;
- strict host/origin/network policy at the proxy;
- room, byte, rate, idle, and connection limits;
- no frame/body logging;
- patched runtime and monitored deployment; and
- rotation of the remote identity after suspected disclosure.

The relay is not an anonymity service and cannot hide network metadata.

## Server and filesystem hardening

- Sandboxed Electron renderer, context isolation, no Node integration
- Twelve-hour bearer sessions and HttpOnly SameSite cookies
- Pairing rate limiting and exact per-device revocation
- Browser origin checks and strict response security headers
- Per-device send/receive/clipboard/backup/remote authorization
- Separate browse, File Provider, and File Request permissions
- Bounded 10-minute remote request replay detection and rejected-replay accounting
- Chunk/body size and exact offset enforcement
- Filename normalization, reserved-name handling, symlink avoidance, and traversal rejection
- Free-space checks and bounded concurrent uploads
- Atomic finalization, replacement backup, and cross-volume fallback
- SQLite WAL, `synchronous=FULL`, bounded history, schema checks, and pre-2.5 backup
- Local-only diagnostics/crash reports with redacted settings and a live health summary
- Protected iOS transfer staging and a durable journal; server-measured offsets remain authoritative
- Authenticated, permission-gated mobile diagnostics and Producer Studio routes
- Recursive Drive search confined to the approved root with no symlink traversal

## Sync safety

Sync manifests hash regular files only, ignore symlinks, cap file counts, and enforce roots. The
native client preserves simultaneous iPhone edits as timestamped conflict copies. Archive deletion
policy moves rather than permanently deletes. Inspect archives before cleanup.

## Drive, requests, and restore points

Drive resolves canonical paths under one approved root, rejects traversal/symlinks, and archives
instead of permanently deleting. Relay Drive mutations can be forced read-only. File Request
tokens are HMAC-derived and only hashed at rest; requests are expiry/size/count bounded and can
require PC approval.

Restore objects are addressed and checked by SHA-256. Restore writes only to a new folder.
Retention removes old manifests and garbage-collects objects no retained point references.

## Data retained

The PC stores settings, transfer metadata, local tags/notes/favorites and hashes, explicitly shared paths, sync/watch profiles,
private-link/File Request metadata, vault metadata/containers, producer-package records, restore
objects/manifests, trusted device names
and token hashes, clipboard history, active staging files, and local diagnostics/crash reports.

No telemetry, advertising ID, PocketDock account, built-in cloud OAuth token, or server recovery
copy is created.

Bonjour advertises only service presence. Native discovery resolves the service through
`NWConnection`; it does not publish a PIN, session credential, refresh token, or transfer key.
Only a previously trusted PC can reconnect by discovery alone.

USB support is intentionally limited to photos/videos Windows exposes through the trusted
portable-device/DCIM boundary. PocketDock does not bypass iOS to read arbitrary Files app or
private application data over USB.

The native iOS target separately enables Apple File Sharing for its own Documents container.
Files copied through Apple Devices are user-controlled staging files inside PocketDock’s sandbox;
they are not an unrestricted view of the iPhone. Sending one through PocketDock still requires an
authenticated, encrypted LAN or relay session.

## Updates and signatures

Update checks are inactive without a configured HTTPS feed. Production executables, installers,
updates, and iOS builds must be signed by the real publisher. Source cannot supply or fabricate
those identities.
