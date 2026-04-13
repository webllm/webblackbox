# @webblackbox/extension

## 0.4.2

### Changed

- Removed the unused `alarms` permission from the packaged extension manifest, tightening the extension's declared permission surface.
- Dropped the matching `chrome.alarms` API typing and README permission note so the codebase and extension docs stay aligned with what the extension actually uses.

## 0.4.1

### Changed

- Added English and Simplified Chinese localization across the popup, options, sessions, content, and offscreen surfaces, including locale-aware page titles, status text, and marker labels.
- Localized the Chrome manifest through `_locales` message catalogs and tightened build validation so packaged release artifacts include the required locale assets.

## 0.4.0

### Changed

- Normalized performance-budget network failure sampling so full-mode `network.response` events with nested response payloads no longer inflate error-rate breaches.
- Simplified the release packaging pipeline into a single Node-based build flow, with manifest validation and updated packaging coverage for the generated Chrome artifact.

## 0.3.0

### Changed

- Hardened popup, options, and sessions rendering by escaping dynamic content and moving the extension pages off string-built markup onto DOM API rendering, with new coverage for the shared HTML helpers and page UI flows.
- Reworked the build and release pipeline so the manifest is generated and validated from package metadata, Chrome Web Store ZIP packaging is pure Node.js, and `pnpm verify` now exercises lint, typecheck, tests, and packaging in one pass.
- Refreshed the packaged extension icons to match the updated WebBlackbox logo.

## 0.2.0

### Changed

- Disabled `Start Lite` and `Start Full` in the popup while the current tab is already recording.
- Added popup regression coverage so same-tab recording keeps start actions locked while other tabs can still start independently.

## 0.1.3

### Changed

- Synced `public/manifest.json`, `build/manifest.json`, and packaged Chrome zip naming to `apps/extension/package.json`.
- Added a manifest sync step so release artifacts stop drifting from the extension package version.

## 0.1.2

### Changed

- Added direct `Sessions` and `Options` navigation actions to the popup.
- Surfaced the extension version in the popup header and bootstrap error state.

## 0.1.1

### Changed

- Hardened the lite perf regression harness so CI waits more reliably for Chrome's DevTools endpoint before failing.
- Improved startup-flake diagnostics by retrying Chrome launches and surfacing more actionable failure context.

## 0.1.0

### Added

- Initial Chrome extension release with lite and full recording modes, popup/options/sessions pages, local export, and Player handoff.
- Included offscreen pipeline storage, CDP-backed full-mode capture, and browser-side lite capture for in-browser recording.
