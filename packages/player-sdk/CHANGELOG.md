# @webblackbox/player-sdk

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

- No Player SDK runtime changes shipped in this release. The package picks up protocol 0.6.0 support for screen-recording archive events and transfer metadata.

### Patch Changes

- Updated dependencies
  - @webblackbox/protocol@0.6.0

## 0.5.0

### Minor Changes

- Rolled up the post-0.4.5 archive reader updates so encrypted event chunks, indexes, privacy manifests, and blob payloads can be opened with the archive passphrase.
- Kept replay diagnostics consistent by counting level-based error events alongside error event types.

### Patch Changes

- Updated dependencies
  - @webblackbox/protocol@0.5.0

## 0.4.5

### Patch Changes

- Added privacy preflight helpers that summarize archive encryption/redaction coverage and provide bounded sensitive-data preview samples before sharing.
- Added replay diagnostics and request/response diff APIs that join actions with network, error, and screenshot evidence for explainable replay confidence.
- Optimized action timeline screenshot and error lookups for large archives by using sorted event indexes instead of repeated full scans.
- Updated dependencies
  - @webblackbox/protocol@0.4.5

## 0.4.4

### Patch Changes

- No Player SDK runtime changes shipped in this release. The version bump keeps the SDK aligned with the hosted Player timeline and marker fixes in the 0.4.4 workspace release.
- Updated dependencies
  - @webblackbox/protocol@0.4.4

## 0.4.3

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the Player SDK aligned with the extension-focused 0.4.3 workspace release.

## 0.4.2

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the Player SDK aligned with the 0.4.2 workspace release.

## 0.4.1

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the Player SDK aligned with the 0.4.1 workspace release.

## 0.4.0

### Changed

- Normalized request-id extraction across query filtering, network aggregation, and action timelines so events linked by `requestId` or nested request payloads stay correlated.
- Added integrity verification for archive opens and on-demand blob reads, with a Node `crypto` fallback for plain-archive hashing in Node runtimes without global Web Crypto.
- Added lite DOM diff support for HTML snapshot blobs and corrected HTML blob MIME round-tripping in archive reads.

## 0.3.0

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the Player SDK aligned with the extension-focused 0.3.0 workspace release.

## 0.2.0

### Changed

- No package-specific runtime changes in this release. The version bump keeps the Player SDK aligned with the 0.2.0 workspace release.

## 0.1.3

### Changed

- No package-specific runtime changes in this release. The version bump keeps the Player SDK aligned with the 0.1.3 workspace release.

## 0.1.2

### Changed

- Refreshed the package README to better describe archive loading, comparison, and analysis helpers for downstream consumers.

## 0.1.1

### Changed

- No package-specific source changes in this release. The version bump kept the Player SDK aligned with the post-0.1.0 workspace release.

## 0.1.0

### Added

- Initial Player SDK release with archive loading, indexing, triage, comparison, and playback helper APIs.
