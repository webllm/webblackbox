# @webblackbox/protocol

## 0.7.0

### Minor Changes

- 1fa66d0: Harden archive reading and the share server.
  - Encrypted archives now encrypt `integrity/hashes.json`. Readers refuse an encrypted archive whose hash list or any session-content entry is missing from the encryption map, so encrypted archives written by earlier versions can no longer be opened, and earlier readers cannot open encrypted archives written by this version.
  - Readers enforce a decompression budget (64 MiB per entry or decoded event chunk, 1 GiB total by default; override with `limits`) and stop inflating an entry as soon as it outgrows its declared size. The exporter refuses to write archives over the same budget, and `maxArchiveBytes` is capped at 1 GiB.
  - The pipeline no longer gives overlapping chunk finalizes the same chunk id, which made storage overwrite a chunk and lose its events, and keeps buffered events when encoding a chunk fails.
  - The share server rejects unknown `Host` headers with `421` (configure `WEBBLACKBOX_SHARE_ALLOWED_HOSTS`; loopback names are accepted on any port), rejects cross-site uploads and revokes with `403`, takes `X-Forwarded-Proto` into account only when `WEBBLACKBOX_TRUST_X_FORWARDED_FOR` is set, and rejects plaintext or incompletely encrypted uploads before decoding them.

## 0.6.0

### Minor Changes

- Added screen-recording event types, validation schemas, and privacy categories for archive playback and filtering.
- Added `screenRecordings` capture policy and `includeScreenRecordings` export policy fields.
- Added WebM and MP4 blob MIME/extension inference for screen-recording chunks.

## 0.5.0

### Minor Changes

- Added capture privacy classification, capture-policy schema support, archive privacy scanner metadata, and export transfer-policy metadata shared by recorder, pipeline, and player tooling.
- Tightened privacy defaults and helpers by disabling body/screenshot capture by default, sanitizing URLs by default, and tokenizing file paths, target selectors, and secret-prefixed path segments.

## 0.4.5

### Patch Changes

- Expanded the default redaction profile to cover additional auth headers, token-like cookie names, sensitive body patterns, and DOM selectors before capture/export.

## 0.4.4

### Patch Changes

- No protocol schema or default changes shipped in this release. The version bump keeps the protocol package aligned with the Player timeline and marker fixes in the 0.4.4 workspace release.

## 0.4.3

### Changed

- No schema or default changes shipped in this release. The version bump keeps the protocol package aligned with the extension-focused 0.4.3 workspace release.

## 0.4.2

### Changed

- No schema or default changes shipped in this release. The version bump keeps the protocol package aligned with the 0.4.2 workspace release.

## 0.4.1

### Changed

- No schema or default changes shipped in this release. The version bump keeps the protocol package aligned with the 0.4.1 workspace release.

## 0.4.0

### Changed

- Added shared helpers to extract request ids from `reqId`, `requestId`, and nested `request.requestId` payload shapes, plus normalized network-response summaries for downstream consumers.
- Added shared HTML blob MIME and file-extension mapping so archive producers and readers can round-trip `text/html` snapshot blobs consistently.

## 0.3.0

### Changed

- No schema or default changes shipped in this release. The version bump keeps the protocol package aligned with the extension-focused 0.3.0 workspace release.

## 0.2.0

### Changed

- No schema or default changes in this release. The version bump keeps the protocol package aligned with the 0.2.0 workspace release.

## 0.1.3

### Changed

- No schema or default changes in this release. The version bump keeps the protocol package aligned with the 0.1.3 workspace release.

## 0.1.2

### Changed

- Refreshed the package README to better document the shared event schema, defaults, and export policy types.

## 0.1.1

### Changed

- No schema or default changes in this release. The version bump kept the protocol package aligned with the post-0.1.0 workspace release.

## 0.1.0

### Added

- Initial shared protocol release with archive manifests, event types, recorder defaults, and export/redaction policy definitions.
