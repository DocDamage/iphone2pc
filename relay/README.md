# PocketDock 4.0 Private Relay

This optional two-peer WebSocket service connects one PocketDock PC and one native iPhone.
PocketDock 4.0 derives ephemeral X25519/HKDF session keys and AES-GCM encrypts complete application request and response envelopes before the
relay sees them. The relay forwards opaque frames and cannot inspect API paths, headers, tokens,
filenames, JSON, status codes, or file/clipboard content.

The service still observes room membership, roles, connection timing, and frame sizes. Its
WebSocket URL also contains a separate room secret, so query-string redaction remains mandatory.

## Local development

```bash
npm install
npm test
PORT=8080 npm start
```

Health: `GET /healthz`

Endpoint:

```text
wss://relay.example.com/v2/relay?room=<random>&role=<pc|iphone>&secret=<random>
```

## Production requirements

- Put the service behind a current TLS reverse proxy.
- Redact the complete query string from access, error, tracing, and analytics logs.
- Do not log WebSocket frame bodies, even though PocketDock 4.0 encrypts them.
- Restrict network/host policy and rate-limit new connections.
- Configure `MAX_MESSAGE_BYTES`, `MAX_BYTES_PER_MINUTE`, `MAX_ROOMS`, and `IDLE_ROOM_MS`.
- Monitor health, connections, process resources, and certificate expiry.
- Rotate PocketDock remote identity after suspected disclosure.

Configure the resulting `wss://` URL under Windows Sync & Backup, scan the remote QR in the native
app, then explicitly enable Remote access for that iPhone in Windows Settings. Browser mode is
local-only.
