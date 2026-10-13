# @webblackbox/share-server

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
  - @webblackbox/player-sdk@0.7.0

## 0.6.0

### Minor Changes

- No share-server runtime changes shipped in this release. The version bump keeps hosted sharing aligned with Player SDK 0.6.0 archive metadata support.

### Patch Changes

- Updated dependencies
  - @webblackbox/player-sdk@0.6.0

## 0.5.0

### Minor Changes

- Rolled up the post-0.4.5 secure sharing flow: public uploads now require encrypted archives, privacy preflight review, scoped API keys, expiry/revocation controls, and audit coverage.
- Hardened upload validation by rejecting plaintext archive content, encrypted archive files uploaded as plaintext blobs, and query-string API key propagation while returning client errors for oversized uploads.

### Patch Changes

- Updated dependencies
  - @webblackbox/player-sdk@0.5.0

## 0.4.5

### Patch Changes

- Added privacy protection reports and bounded sensitive-data previews to generated share summaries.
- Updated dependencies
  - @webblackbox/player-sdk@0.4.5

## 0.4.4

### Patch Changes

- No share-server runtime changes shipped in this release. The version bump keeps the share server aligned with the Player timeline and marker fixes in the 0.4.4 workspace release.
- Updated dependencies
  - @webblackbox/player-sdk@0.4.4

## 0.4.3

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the share server aligned with the extension-focused 0.4.3 workspace release.

## 0.4.2

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the share server aligned with the 0.4.2 workspace release.

## 0.4.1

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the share server aligned with the 0.4.1 workspace release.

## 0.4.0

### Changed

- No package-specific source changes shipped in this release.
- Picked up `@webblackbox/player-sdk` 0.4.0, so uploaded archives are analyzed with integrity verification on read and more consistent request/action correlation in generated summaries.

## 0.3.0

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the share server aligned with the extension-focused 0.3.0 workspace release.

## 0.2.0

### Changed

- No package-specific runtime changes in this release. The version bump keeps the share server aligned with the 0.2.0 workspace release.

## 0.1.3

### Changed

- No package-specific runtime changes in this release. The version bump keeps the share server aligned with the 0.1.3 workspace release.

## 0.1.2

### Changed

- No package-specific runtime changes in this release. The version bump kept the share server aligned with the rest of the workspace.

## 0.1.1

### Changed

- No package-specific runtime changes in this release. The version bump kept the share server aligned with the post-0.1.0 workspace release.

## 0.1.0

### Added

- Initial share-server release with archive upload, listing, metadata, download, and browser share-link endpoints.
- Included configurable API-key, origin, retention, and upload-limit hooks for self-hosted collaboration workflows.
