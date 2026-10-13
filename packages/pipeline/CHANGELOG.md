# @webblackbox/pipeline

## 0.7.0

### Minor Changes

- 1fa66d0: Harden archive reading and the share server.
  - Encrypted archives now encrypt `integrity/hashes.json`. Readers refuse an encrypted archive whose hash list or any session-content entry is missing from the encryption map, so encrypted archives written by earlier versions can no longer be opened, and earlier readers cannot open encrypted archives written by this version.
  - Readers enforce a decompression budget (64 MiB per entry or decoded event chunk, 1 GiB total by default; override with `limits`) and stop inflating an entry as soon as it outgrows its declared size. The exporter refuses to write archives over the same budget, and `maxArchiveBytes` is capped at 1 GiB.
  - The pipeline no longer gives overlapping chunk finalizes the same chunk id, which made storage overwrite a chunk and lose its events, and keeps buffered events when encoding a chunk fails.
  - The share server rejects unknown `Host` headers with `421` (configure `WEBBLACKBOX_SHARE_ALLOWED_HOSTS`; loopback names are accepted on any port), rejects cross-site uploads and revokes with `403`, takes `X-Forwarded-Proto` into account only when `WEBBLACKBOX_TRUST_X_FORWARDED_FOR` is set, and rejects plaintext or incompletely encrypted uploads before decoding them.

### Patch Changes

- Updated dependencies [1fa66d0]
  - @webblackbox/protocol@0.7.0

## 0.6.0

### Minor Changes

- Added independent export filtering for screen-recording events and blobs through `includeScreenRecordings`.
- Included screen-recording selection in export transfer-policy metadata and low-risk plaintext override checks.

### Patch Changes

- Updated dependencies
  - @webblackbox/protocol@0.6.0

## 0.5.0

### Minor Changes

- Rolled up the post-0.4.5 privacy/export pipeline: archives now carry scanner results, export transfer policy metadata, encrypted private indexes/blobs, real-user encryption enforcement, and trusted plaintext exemption checks.
- Added explicit support for local plaintext exports through `allowPlaintextLocalExport`, while privacy findings now warn instead of blocking local downloads by default.
- Applied default export policy bounds consistently and kept returned archive integrity metadata stable after export.

### Patch Changes

- Updated dependencies
  - @webblackbox/protocol@0.5.0

## 0.4.6

### Patch Changes

- Added an explicit `allowPlaintextLocalExport` export option for trusted local download flows that intentionally leave archives unencrypted while preserving encrypted exports when a passphrase is supplied.

## 0.4.5

### Patch Changes

- No pipeline runtime changes shipped in this release. The version bump keeps the package aligned with the 0.4.5 capture performance, privacy preflight, and replay diagnostics workspace release.
- Updated dependencies
  - @webblackbox/protocol@0.4.5

## 0.4.4

### Patch Changes

- No pipeline runtime changes shipped in this release. The version bump keeps the pipeline package aligned with the Player timeline and marker fixes in the 0.4.4 workspace release.
- Updated dependencies
  - @webblackbox/protocol@0.4.4

## 0.4.3

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the pipeline package aligned with the extension-focused 0.4.3 workspace release.

## 0.4.2

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the pipeline package aligned with the 0.4.2 workspace release.

## 0.4.1

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the pipeline package aligned with the 0.4.1 workspace release.

## 0.4.0

### Changed

- Resumed chunk sequence numbers from stored session state after recovery so restarted pipelines stop overwriting earlier chunks for the same session.
- Anchored `recentWindowMs` exports to the latest session activity for completed sessions instead of the export wall clock time.
- Enforced archive integrity manifests on read, including file-set verification and per-file hash checks, and aligned request indexing with nested `request.requestId` payloads.
- Added a Node `crypto` fallback for SHA-256 hashing when Web Crypto is unavailable in Node-based archive tooling.

## 0.3.0

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the pipeline package aligned with the extension-focused 0.3.0 workspace release.

## 0.2.0

### Changed

- No package-specific runtime changes in this release. The version bump keeps the pipeline package aligned with the 0.2.0 workspace release.

## 0.1.3

### Changed

- No package-specific runtime changes in this release. The version bump keeps the pipeline package aligned with the 0.1.3 workspace release.

## 0.1.2

### Changed

- Refreshed the package README to better document archive export, persistence, and storage responsibilities.

## 0.1.1

### Changed

- No package-specific source changes in this release. The version bump kept the pipeline package aligned with the post-0.1.0 workspace release.

## 0.1.0

### Added

- Initial archive pipeline with chunk/blob storage, encrypted export support, and pluggable persistence backends.
