# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose recovered files, pairing tokens, device identifiers, or signing keys. Use GitHub's private vulnerability reporting for this repository when available, or contact the repository owner privately.

Include the affected version, reproduction steps, impact, and any suggested mitigation. Avoid attaching real iPhone files, pairing records, database contents, ETW traces, or other private recovery artifacts.

## Security model

iDrivePulse is local-first. Its main web service binds to `127.0.0.1`, rejects cross-site API requests, and does not upload recovered content. The optional companion exchange is disabled by default and uses TLS certificate pinning, single-use pairing codes, expiring bearer tokens, and SHA-256 download verification.

The application does not jailbreak iOS, bypass Data Protection, remove DRM, defeat the Trust This Computer boundary, or claim unrestricted access to app-private storage. Reported issues that require weakening those boundaries will not be treated as supported features.

## Supported versions

Security fixes are applied to the current `main` branch. Use the newest tagged release once releases are published.
