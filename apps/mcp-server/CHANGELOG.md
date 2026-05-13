# @webblackbox/mcp-server

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
