# @webblackbox/recorder

## 0.4.0

### Changed

- Normalized request-id extraction through the shared protocol helpers so action-span tracking and content-event normalization accept `reqId`, `requestId`, and nested `request.requestId` consistently.
- Backfilled `ref.req` on action-linked events when request ids are only present in payload data, keeping downstream request/action association stable.

## 0.3.0

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the recorder package aligned with the extension-focused 0.3.0 workspace release.

## 0.2.0

### Changed

- No package-specific runtime changes in this release. The version bump keeps the recorder package aligned with the 0.2.0 workspace release.

## 0.1.3

### Changed

- No package-specific runtime changes in this release. The version bump keeps the recorder package aligned with the 0.1.3 workspace release.

## 0.1.2

### Changed

- Refreshed the package README to better document recorder configuration, freeze policy, and export responsibilities.

## 0.1.1

### Changed

- No package-specific source changes in this release. The version bump kept the recorder package aligned with the post-0.1.0 workspace release.

## 0.1.0

### Added

- Initial recorder package with ring-buffer capture management, freeze-policy evaluation, redaction helpers, and export orchestration.
