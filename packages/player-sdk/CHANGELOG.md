# @webblackbox/player-sdk

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
