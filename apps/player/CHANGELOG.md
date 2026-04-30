# @webblackbox/player

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
