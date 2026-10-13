# webblackbox

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
  - @webblackbox/pipeline@0.7.0
  - @webblackbox/recorder@0.7.0

## 0.6.0

### Minor Changes

- Added the Lite SDK `includeScreenRecordings` export option so browser exports can include or exclude captured recording artifacts independently.

### Patch Changes

- Updated dependencies
  - @webblackbox/pipeline@0.6.0
  - @webblackbox/protocol@0.6.0
  - @webblackbox/recorder@0.6.0

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
