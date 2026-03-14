# @webblackbox/extension

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
