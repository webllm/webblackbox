# WebBlackbox Security Overview

## Extension Permissions

The store-safe Chrome profile uses `activeTab` and programmatic injection after a user gesture. It does not include `debugger`, persistent `<all_urls>` host permissions, or always-on all-sites content scripts.

The dev/enterprise profile can enable deeper diagnostics, including CDP, but these controls are separated from the store-safe profile and remain governed by the same capture-scope evaluator. Both profiles use a passive programmatic bootstrap and activate capture instrumentation only after a frame passes the scope gate; neither profile installs an always-on all-frame capture script.

## Data Flow

1. A fail-closed scope gate validates tab, origin allow/deny rules, excluded URLs, frame inclusion, origin-change behavior, and consent lifetime before capture instrumentation is activated.
2. Content, webRequest, and CDP ingress repeat the scope check so a stale or spoofed frame cannot expand consent.
3. Capture adapters sanitize data before it enters the recorder pipeline.
4. The ingest gate rejects or replaces policy-violating artifacts with `privacy.violation` events.
5. Archives include `privacy/manifest.json` with policy, categories, encryption status, and pre-encryption scanner result.
6. Exports recompute policy eligibility. The Player evaluates decrypted content before sharing, while the keyless Share server enforces only server-inspected outer facts and labels client private-content results as unverified claims.

MAIN-world capture hooks run in the page's JavaScript environment and are therefore treated as untrusted observations, not authenticated evidence. Their bridge accepts only bounded, allowlisted event payloads, ignores page-supplied timestamps, rate-limits input, and exposes no marker or other extension control operation. Privileged decisions remain in the isolated content script and service worker.

Global visual and profiler artifacts fail closed when the page contains a child frame that is outside the effective scope. CDP DOM snapshots are filtered to frame IDs that independently passed the scope gate.

## Encryption

Real-user archives require export encryption. Public share uploads require encrypted `.webblackbox` archives and never accept passphrases. Private archive paths include event chunks, blobs, indexes, and `privacy/manifest.json`; older encrypted archives with plaintext private files must be re-exported before public sharing. Client-side share metadata is limited to an allowlisted public claim bound to the exact archive bytes by SHA-256.

Local event chunks and blobs are also protected before persistent storage. The pipeline rejects persistent storage that does not declare authenticated AES-GCM payload protection when `localAtRest` is required. The extension stores a non-extractable, purpose-specific Web Crypto key in an extension-origin IndexedDB keyring so offscreen/service-worker restarts can recover the cache without exporting raw key material. On upgrade, the legacy plaintext database is purged; if the managed key is lost, unverifiable cached payloads are purged rather than read as plaintext.

Plaintext synthetic or local-debug export exemptions require a well-formed `captureContextEvidenceRef` that is also allowlisted by the trusted pipeline/embedder configuration. A capture policy cannot make its own plaintext exemption trusted.

## Player Safety

The player treats archives as untrusted input. It does not load captured external resources by default, limits replay resources to inert local object/data URLs, revokes screenshot object URLs after a short TTL, and serves player/share views with no-referrer and restrictive CSP controls. Archive input bytes, ZIP entries, expanded bytes, compression ratios, decoded event bytes, event counts, and codec time are subject to non-relaxable safety ceilings; callers may only tighten them. Remote share servers must use HTTPS; plaintext HTTP is accepted only for loopback development endpoints so share API credentials are not sent over an unprotected remote connection.

## Share Server

The share server supports scoped API keys, upload rate limits, expiry, revocation, redacted metadata, and redacted audit logs. Public deployments should keep plaintext uploads disabled; disabled plaintext is rejected after bounded envelope inspection and before Player private-content analysis. If plaintext uploads are explicitly enabled, the server re-scans bounded decoded events and text-like blobs, requires canonical blob coverage, strictly decodes UTF-8, and scans raw JSON plus decoded keys and string values. It never promotes an archive-declared `passed` result to server attestation. The stored result is labeled as an upload-time rather than pre-encryption scan. Invalid archive metadata/event encodings are rejected; opaque or undecodable blobs and exhausted byte/finding/time budgets produce `unknown` with partial-analysis trust, while a detected high-risk finding blocks retention. Encrypted envelopes must have exact private-file/IV metadata, canonical blob totals, and matching stored-byte integrity before retention. Because the server has no archive passphrase, it labels encrypted-content privacy results as archive-bound but unverified client claims; matching a digest is not proof that the client scanner ran honestly. Deployments that require privacy attestation need a trusted signed or remote pre-encryption analysis path.

## Reporting Security Issues

Report suspected security issues privately to the project maintainers. Do not include captured customer data, passphrases, or raw archive contents in reports.
