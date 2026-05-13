# webblackbox

## 0.5.0

### Minor Changes

- Rolled up the post-0.4.5 browser SDK privacy defaults: lite capture keeps screenshots off by default, avoids raw input/local-storage values, counts storage identifiers only, and sanitizes URLs and targets before capture.
- Threaded capture policy through the browser SDK export path, including real-user encryption enforcement, trusted plaintext exemption checks, and allowlisted captured network headers.

### Patch Changes

- Updated dependencies
  - @webblackbox/pipeline@0.5.0
  - @webblackbox/protocol@0.5.0
  - @webblackbox/recorder@0.5.0

## 0.4.5

### Patch Changes

- Kept injected lite capture hooks inactive until recording starts, then synced active state and body-capture limits through start/stop to reduce page overhead outside capture.
- Reduced full-mode page-thread sampling by throttling pointer tracking, skipping duplicate top-level performance capture, and timeboxing screenshot capture work.
- Updated dependencies
  - @webblackbox/pipeline@0.4.5
  - @webblackbox/protocol@0.4.5
  - @webblackbox/recorder@0.4.5

## 0.4.4

### Patch Changes

- No browser SDK runtime changes shipped in this release. The version bump keeps the package aligned with the Player timeline and marker fixes in the 0.4.4 workspace release.
- Updated dependencies
  - @webblackbox/pipeline@0.4.4
  - @webblackbox/protocol@0.4.4
  - @webblackbox/recorder@0.4.4

## 0.4.3

### Changed

- No browser SDK source or runtime changes shipped in this release. The version bump keeps the package aligned with the extension-focused 0.4.3 workspace release.

## 0.4.2

### Changed

- No browser SDK source or runtime changes shipped in this release. The version bump keeps the package aligned with the 0.4.2 workspace release.

## 0.4.1

### Changed

- No browser SDK source or runtime changes shipped in this release. The version bump keeps the package aligned with the 0.4.1 workspace release.

## 0.4.0

### Changed

- Lite SDK exports that materialize DOM snapshots as HTML blobs now round-trip correctly through the archive pipeline and player stack.
- Picked up the pipeline/protocol/recorder 0.4.0 updates for integrity-checked archive handling and consistent request-id normalization across downstream tooling.

## 0.3.0

### Changed

- No browser SDK source or runtime changes shipped in this release. The version bump keeps the package aligned with the extension-focused 0.3.0 workspace release.

## 0.2.0

### Changed

- No browser SDK runtime changes in this release. The version bump keeps the package aligned with the 0.2.0 workspace release.

## 0.1.3

### Changed

- No browser SDK runtime changes in this release. The version bump keeps the package aligned with the 0.1.3 workspace release.

## 0.1.2

### Changed

- Refreshed the package README and public package docs for the renamed `webblackbox` browser SDK.

## 0.1.1

### Changed

- No browser SDK source changes in this release. The version bump kept the package aligned with the post-0.1.0 workspace release.

## 0.1.0

### Added

- Initial browser-side lite capture SDK release with event capture, DOM/materializer helpers, and injected page hooks.
- Published the package under the `webblackbox` name after the workspace directory rename from `packages/web-sdk`.
