# @webblackbox/share-server

## 0.6.0

### Minor Changes

- Added server-owned, upload-time privacy analysis for deployments that explicitly enable plaintext
  share uploads.

### Patch Changes

- Re-scanned explicitly allowed plaintext archives on the server instead of promoting an embedded
  `passed` scanner claim to server attestation; decoded sensitive events or text-like blobs now
  block retention, accepted summaries identify the result as an upload-time scan, and opaque or
  budget-limited content keeps the public scanner status `unknown` with partial-analysis trust.
- Rejected non-canonical and mismatched blob layouts, strictly decoded UTF-8 and JSON strings, and
  bounded server scan bytes, findings, and elapsed time without caching every decoded blob.
- Verified encrypted envelope required paths, exact private-file/IV metadata, stored-byte integrity,
  and canonical blob totals before retention, and downgraded persisted server attestations that lack
  complete count-consistent scan coverage.
- Updated dependencies
  - @webblackbox/pipeline@0.6.0
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
