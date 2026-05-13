# @webblackbox/player-sdk

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
