# @webblackbox/pipeline

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
