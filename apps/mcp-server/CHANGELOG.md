# @webblackbox/mcp-server

## 0.7.0

### Minor Changes

- 1fa66d0: Harden archive reading and the share server.
  - Encrypted archives now encrypt `integrity/hashes.json`. Readers refuse an encrypted archive whose hash list or any session-content entry is missing from the encryption map, so encrypted archives written by earlier versions can no longer be opened, and earlier readers cannot open encrypted archives written by this version.
  - Readers enforce a decompression budget (64 MiB per entry or decoded event chunk, 1 GiB total by default; override with `limits`) and stop inflating an entry as soon as it outgrows its declared size. The exporter refuses to write archives over the same budget, and `maxArchiveBytes` is capped at 1 GiB.
  - The pipeline no longer gives overlapping chunk finalizes the same chunk id, which made storage overwrite a chunk and lose its events, and keeps buffered events when encoding a chunk fails.
  - The share server rejects unknown `Host` headers with `421` (configure `WEBBLACKBOX_SHARE_ALLOWED_HOSTS`; loopback names are accepted on any port), rejects cross-site uploads and revokes with `403`, takes `X-Forwarded-Proto` into account only when `WEBBLACKBOX_TRUST_X_FORWARDED_FOR` is set, and rejects plaintext or incompletely encrypted uploads before decoding them.

### Patch Changes

- Updated dependencies [1fa66d0]
  - @webblackbox/player-sdk@0.7.0

## 0.6.0

### Minor Changes

- No MCP server runtime or CLI changes shipped in this release. The package picks up Player SDK archive support for 0.6.0 screen-recording metadata.

### Patch Changes

- Updated dependencies
  - @webblackbox/player-sdk@0.6.0

## 0.5.0

### Minor Changes

- Rolled up the post-0.4.5 archive-inspection updates from Player SDK 0.5.0 so MCP tooling can read the hardened privacy/export archive format.
- Limited archive listings after sorting so CLI/session-tool results stay deterministic before pagination limits are applied.

### Patch Changes

- Updated dependencies
  - @webblackbox/player-sdk@0.5.0

## 0.4.5

### Patch Changes

- No MCP server runtime or CLI changes shipped in this release. The package picks up Player SDK 0.4.5 replay diagnostics and privacy preflight analysis.
- Updated dependencies
  - @webblackbox/player-sdk@0.4.5

## 0.4.4

### Patch Changes

- No MCP server runtime or CLI changes shipped in this release. The version bump keeps the MCP server aligned with the Player timeline and marker fixes in the 0.4.4 workspace release.
- Updated dependencies
  - @webblackbox/player-sdk@0.4.4

## 0.4.3

### Changed

- No package-specific runtime or CLI changes shipped in this release. The version bump keeps the MCP server aligned with the extension-focused 0.4.3 workspace release.

## 0.4.2

### Changed

- No package-specific runtime or CLI changes shipped in this release. The version bump keeps the MCP server aligned with the 0.4.2 workspace release.

## 0.4.1

### Changed

- No package-specific runtime or CLI changes shipped in this release.
- Updated internal archive-integrity test fixtures to match the stricter archive verification used by the 0.4.x toolchain.

## 0.4.0

### Changed

- No package-specific source changes shipped in this release.
- Picked up `@webblackbox/player-sdk` 0.4.0, so archive inspection now benefits from stricter integrity verification on open and more consistent request-id matching in queries and action timelines.

## 0.3.0

### Changed

- No package-specific runtime or CLI changes shipped in this release. The version bump keeps the MCP server aligned with the extension-focused 0.3.0 workspace release.

## 0.2.0

### Changed

- No package-specific runtime or CLI changes in this release. The version bump keeps the MCP server aligned with the 0.2.0 workspace release.

## 0.1.3

### Changed

- No package-specific runtime or CLI changes in this release. The version bump keeps the MCP server aligned with the 0.1.3 workspace release.

## 0.1.2

### Changed

- Expanded the package README with direct stdio invocation examples and local inspection commands.

## 0.1.1

### Changed

- No package-specific source changes in this release. The version bump kept the CLI aligned with the post-0.1.0 workspace release.

## 0.1.0

### Added

- Initial MCP server CLI release for inspecting WebBlackbox archives over stdio.
- Included tools for session summaries, network/error triage, bug report generation, and Playwright script generation.
