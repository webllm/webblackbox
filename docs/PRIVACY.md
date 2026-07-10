# WebBlackbox Privacy Model

WebBlackbox is a browser debugging recorder. The commercial privacy baseline is local-first, minimal capture, explicit export, and encrypted sharing.

## Default Collection

By default, WebBlackbox records metadata needed to debug a session:

- user action metadata, not raw typed values
- network method, status, type, timing, and sanitized URL shape
- console metadata, not raw free-form payloads
- storage counts, not values or key names
- privacy provenance and scanner results

By default, WebBlackbox does not collect raw input values, DOM text, screenshots, storage values, cookies, raw headers, request bodies, or response bodies.

## Capture Scope And Consent

The extension binds each session to the selected tab and starting origin. The same effective scope is evaluated before startup, after top-level navigation, before frame capture instrumentation is activated, and again when content, webRequest, or CDP events arrive. Denied origins and excluded URL patterns always win; a non-empty origin allowlist is restrictive; opaque or invalid document URLs fail closed.

`stopOnOriginChange` is preserved from the configured policy and defaults to `true`. Child-frame capture is disabled unless `includeSubframes` is explicitly enabled, and enabled child frames must independently pass the origin, URL, tab, and consent checks. Capture stops when time-bounded consent expires.

## Local Storage

Captured sessions remain local until the user exports or shares an archive. Under the required local-at-rest policy, persisted event chunks and blobs are authenticated and encrypted with AES-GCM; raw persistent storage is rejected. Extension upgrades purge the former plaintext cache, and a missing managed key causes unverifiable cached payloads to be purged instead of silently reopened. Query indexes and session metadata remain plaintext and must not contain captured payload values. Local stopped sessions are subject to retention controls, and enterprise policies can cap local retention.

## Export And Share

Real-user archives must be encrypted before export or share. The public share server stores encrypted archive bytes and redacted public metadata. It does not receive archive passphrases or decryption keys, and it rejects encrypted uploads that leave private archive files, including event chunks, blobs, indexes, or privacy manifests, in plaintext. Player-generated privacy claims include the SHA-256 of the exact uploaded archive, but the server labels their private-content results as unverified client claims because digest binding provides integrity between the claim and bytes, not authenticity or scanner attestation.

Public share links expire, can be revoked, and generate redacted audit events. Audit records do not include captured payloads, passphrases, API keys, raw URLs, raw selectors, or archive plaintext.

## Deletion

Deleting a local session removes local indexes, chunks, blobs, annotations, and object URLs. Revoking a share blocks future access. Expired share records and archive bytes are pruned according to the configured retention window.

## Telemetry And Logs

Operational logs and audit logs must not contain captured payloads, raw URLs, raw selectors, consent PII, passphrases, derived keys, archive plaintext, URL fragments, or selector hash keys.
