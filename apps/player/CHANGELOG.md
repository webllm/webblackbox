# @webblackbox/player

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
  - @webblackbox/player-sdk@0.7.0

## 0.6.0

### Minor Changes

- Added screen-recording playback in the main stage, including WebM/MP4 blob loading, recording timeline markers, metadata, and synchronized seeking.
- Unified recording playback with the existing log playback progress bar so screenshots, recordings, actions, network, and errors share one timeline control.
- Updated Player CSP and localized UI strings for browser-safe video playback from archive blobs.

### Patch Changes

- Updated dependencies
  - @webblackbox/player-sdk@0.6.0
  - @webblackbox/protocol@0.6.0

## 0.5.0

### Minor Changes

- Rolled up the post-0.4.5 replay and sharing hardening work: replay views now stay within the Player CSP, block external replay resources, render runtime progress markers correctly, and flag metadata-only archives more clearly.
- Improved privacy-focused sharing output by using redacted client summaries and consistent error-count handling in replay diagnostics.

### Patch Changes

- Updated dependencies
  - @webblackbox/player-sdk@0.5.0
  - @webblackbox/protocol@0.5.0

## 0.4.5

### Patch Changes

- Added share privacy preflight UI that requires review of redaction coverage, detected sensitive signals, and preview samples before upload.
- Added replay confidence diagnostics to action cards so actions show joined trigger, request, error, and screenshot evidence.
- Reused computed replay diagnostic inputs during rendering to keep large-archive action views responsive.
- Updated dependencies
  - @webblackbox/player-sdk@0.4.5
  - @webblackbox/protocol@0.4.5

## 0.4.4

### Patch Changes

- Fixed playback timelines for archives that mix monotonic-time domains, so Play no longer stretches the session range and screenshot/network/action markers stay aligned with the loaded log.
- Restored visible, clickable progress markers and playhead rendering for screenshots, network requests, errors, and actions.
- Kept Playwright preview range filtering in the Player's normalized playback-time domain so partial-range scripts do not drop events from mixed-time archives.
- Updated dependencies
  - @webblackbox/player-sdk@0.4.4
  - @webblackbox/protocol@0.4.4

## 0.4.3

### Changed

- No package-specific UI or runtime changes shipped in this release. The version bump keeps the hosted Player aligned with the extension-focused 0.4.3 workspace release.

## 0.4.2

### Changed

- No package-specific UI or runtime changes shipped in this release. The version bump keeps the hosted Player aligned with the 0.4.2 workspace release.

## 0.4.1

### Changed

- Added English and Simplified Chinese localization across the hosted Player UI, including a toolbar language switcher that persists the selected locale.
- Localized compare summaries, network labels, screenshot descriptions, response preview copy, and share/load dialogs so generated analysis output follows the active language.
- Minified the Player build output to keep CI artifacts and hosted bundles smaller.

## 0.4.0

### Changed

- Normalized request-id extraction for scope inference, so main/iframe request scoping stays correct when events carry `requestId` in payload data instead of `ref.req`.
- Picked up `@webblackbox/player-sdk` 0.4.0 improvements, including integrity-checked archive opens and lite DOM diff support for HTML snapshot blobs.

## 0.3.0

### Changed

- Refreshed the hosted Player logo assets to match the updated WebBlackbox branding. No Player UI or runtime behavior changed in this release.

## 0.2.0

### Changed

- No package-specific UI or runtime changes in this release. The version bump keeps the hosted player aligned with the 0.2.0 workspace release.

## 0.1.3

### Changed

- Fixed GitHub Pages deployment authentication so release automation can push the `gh-pages` branch reliably from CI.

## 0.1.2

### Changed

- Made the empty playback stage clickable and keyboard-focusable as a shortcut to the archive file picker.

## 0.1.1

### Changed

- No package-specific source changes in this release. The version bump kept the Player aligned with the post-0.1.0 workspace release.

## 0.1.0

### Added

- Initial WebBlackbox archive player release with timeline, screenshots, network waterfall, console/error inspection, and archive comparison views.
- Included hosted-player deployment support, share flow integration, and player branding assets for the web UI.
