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

## Local Storage

Captured sessions remain local until the user exports or shares an archive. Local stopped sessions are subject to retention controls, and enterprise policies can cap local retention.

## Export And Share

Real-user archives must be encrypted before export or share. The public share server stores encrypted archive bytes and redacted public metadata. It does not receive archive passphrases or decryption keys, and it rejects encrypted uploads that leave private archive indexes or privacy manifests in plaintext.

Public share links expire, can be revoked, and generate redacted audit events. Audit records do not include captured payloads, passphrases, API keys, raw URLs, raw selectors, or archive plaintext.

## Deletion

Deleting a local session removes local indexes, chunks, blobs, annotations, and object URLs. Revoking a share blocks future access. Expired share records and archive bytes are pruned according to the configured retention window.

## Telemetry And Logs

Operational logs and audit logs must not contain captured payloads, raw URLs, raw selectors, consent PII, passphrases, derived keys, archive plaintext, URL fragments, or selector hash keys.
