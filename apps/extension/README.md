# WebBlackbox Chrome Extension

Chrome Manifest V3 extension that continuously records web session data using the Chrome DevTools Protocol and content script injection.

## Architecture

The extension consists of multiple main components:

```
┌─────────────────────────────────────────────────────────┐
│                    Chrome Extension                      │
│                                                          │
│  ┌───────────┐    ┌───────────┐    ┌────────────────┐   │
│  │  Injected  │    │  Content  │    │    Service     │   │
│  │  Script    │───→│  Script   │───→│    Worker      │   │
│  └───────────┘    └───────────┘    └───────┬────────┘   │
│  postMessage       chrome.runtime           │            │
│  (console,          .connect/.postMessage   │ CDP        │
│   storage)          (user, DOM)             │            │
│                                    ┌───────▼────────┐   │
│  ┌───────────┐                     │   Offscreen    │   │
│  │  Popup /  │                     │   Document     │   │
│  │  Options  │                     │   (Pipeline)   │   │
│  └───────────┘                     └────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Components

#### Service Worker (`sw.js`)

- **Central coordinator** for all recording activity
- Manages CDP debugger connections via `@webblackbox/cdp-router`
- Instantiates `WebBlackboxRecorder` for event normalization
- Routes events between content scripts, CDP, and the pipeline
- Handles session lifecycle (start, stop, freeze, export)
- Captures storage snapshots, including cookies, through CDP storage commands
- Manages the offscreen document lifecycle

#### Content Script (`content.js`)

- Injected at `document_start` on all URLs
- Captures user interaction events (click, input, scroll, keydown, etc.)
- Captures DOM mutations via MutationObserver
- Takes DOM snapshots at configured intervals
- Captures screenshots via SnapDOM
- Forwards events to the service worker via `chrome.runtime.connect` + `port.postMessage`

#### Injected Script (`injected.js`)

- Web-accessible resource injected into the page context
- Intercepts console API calls (log, warn, error, etc.)
- Monitors storage operations (localStorage, sessionStorage, IndexedDB, cookies)
- Communicates with the content script via `window.postMessage`

#### Offscreen Document

- Runs the `FlightRecorderPipeline` for event processing
- Handles chunking, compression, indexing, and blob storage
- Generates `.webblackbox` ZIP archives on export
- Isolated from the main page for performance

#### Popup (`popup.html`)

- Quick controls for starting/stopping recording sessions
- Session status display
- Archive policy controls and export trigger

#### Options Page (`options.html`)

- Full recorder configuration UI
- Runtime profile overview for shipped `lite` / `full` modes
- Sampling cadence and ring-buffer configuration
- Freeze-on-error and performance budget controls
- Network body capture byte cap
- Redaction rule management
- Screenshot cadence tuning

#### Sessions Page (`sessions.html`)

- Browse and manage recorded sessions
- View session metadata and statistics
- Export and delete sessions

## rrweb Status

`dom.rrweb.event` is emitted from lite-mode mutation summaries (`schema: rrweb-lite/v1`) and ingested through the standard content-event pipeline.

## Permissions

| Permission   | Purpose                                          |
| ------------ | ------------------------------------------------ |
| `debugger`   | CDP access for network, runtime, and page events |
| `tabs`       | Tab information and URL access                   |
| `scripting`  | Content script injection                         |
| `storage`    | Extension settings and session data              |
| `offscreen`  | Pipeline processing in background                |
| `webRequest` | Network request monitoring                       |
| `downloads`  | Archive file download                            |
| `<all_urls>` | Content script injection on any page             |

## Keyboard Shortcuts

| Shortcut                   | Action             |
| -------------------------- | ------------------ |
| `Ctrl+Shift+M` (Win/Linux) | Create user marker |
| `Cmd+Shift+M` (Mac)        | Create user marker |

User markers are `user.marker` events that serve as bookmarks in the recording timeline. They always trigger the marker freeze reason.

## Build

```bash
cd apps/extension
pnpm build
pnpm build:release
pnpm package:chrome
pnpm verify
```

The build output is in the `build/` directory. The manifest is generated from `apps/extension/package.json` during the build, so there is no source `public/manifest.json` to keep in sync. Local `pnpm build` runs keep the stable development `key`, while `pnpm build:release` generates an unpacked release build without that `key` so you can do store-parity checks before upload. `pnpm package:chrome` rebuilds the extension once, validates the generated manifest, and creates a Chrome Web Store upload ZIP in `dist/` with the release manifest. Packaging is pure Node.js, so it does not depend on a system `zip` binary being installed. `pnpm verify` runs the extension's lint, typecheck, test, and packaging pipeline in one command. You can override the ZIP path with `node scripts/build-extension.mjs --package --output ./dist/custom-name.zip`.

Build entries:

| Entry          | Output               | Description          |
| -------------- | -------------------- | -------------------- |
| `sw.ts`        | `build/sw.js`        | Service worker       |
| `content.ts`   | `build/content.js`   | Content script       |
| `offscreen.ts` | `build/offscreen.js` | Offscreen document   |
| `popup.ts`     | `build/popup.js`     | Popup UI             |
| `options.ts`   | `build/options.js`   | Options page         |
| `sessions.ts`  | `build/sessions.js`  | Sessions page        |
| `injected.ts`  | `build/injected.js`  | Injected page script |

## E2E

- `pnpm e2e:fullchain:full` runs the full-mode end-to-end capture/export demo.
- `pnpm e2e:realworld` and `pnpm e2e:realworld:ci` run the real-world stability matrix across lite/full startup paths, reload recovery, iframe/child-target capture, downloads/uploads, large response previews, export, and player replay. Use `pnpm e2e:realworld:quick` for the reduced local smoke slice.
- `pnpm e2e:memory:full` runs a synthetic long-session full-mode stress case and samples JS heap usage for the target page, service worker, and offscreen document.
- `pnpm e2e:perf:lite` runs a lite-mode A/B stress matrix that now covers same-page request/hover pressure, real document navigation, iframe-heavy interaction, and contenteditable typing before comparing baseline vs active-recording budgets.
- `pnpm e2e:perf:lite:ci` runs a reduced version of the same lite perf matrix so CI can gate regressions without paying the full local-runtime cost.
- Useful env vars for the memory regression script: `WB_E2E_STRESS_REQUESTS`, `WB_E2E_STRESS_CONCURRENCY`, `WB_E2E_MEMORY_SAMPLE_MS`, `WB_E2E_OFFSCREEN_FINAL_GROWTH_MB`, `WB_E2E_SW_FINAL_GROWTH_MB`.
- Useful env vars for the lite perf regression script: `WB_E2E_PERF_REQUESTS`, `WB_E2E_PERF_CONCURRENCY`, `WB_E2E_PERF_PAYLOAD_BYTES`, `WB_E2E_PERF_IFRAME_COUNT`, `WB_E2E_PERF_EDITOR_ROUNDS`, `WB_E2E_PERF_NAV_ROUNDS`, `WB_E2E_PERF_NAV_WAIT_MS`, `WB_E2E_PERF_AFTER_START_SETTLE_MS`, `WB_E2E_PERF_FETCH_P95_DELTA_MS`, `WB_E2E_PERF_HOVER_P95_DELTA_MS`.

## Loading in Chrome

1. Run `pnpm build` in the extension directory
2. Open `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select the `apps/extension/build` directory

## Data Flow

### Recording

1. User clicks **Start** in popup
2. Service worker creates session, attaches CDP debugger, initializes recorder
3. `content.js` is already present as a manifest `document_start` content script across frames
4. Injected content capture begins streaming user events and DOM summaries
5. In `lite` mode, injected script captures console/network/storage events
6. CDP provides network, runtime exception, and page navigation events
7. Service worker normalizes all events through the recorder
8. Normalized events are batched and sent to the offscreen pipeline
9. Pipeline chunks, indexes, and stores events

### Export

1. User clicks **Export** in popup
2. Popup export policy is applied (defaults: `includeScreenshots=false`, `maxArchiveBytes=100MB`, `recentWindowMs=20 minutes`)
3. Service worker signals the pipeline to export with policy + optional encryption
4. Pipeline finalizes indexes, generates archive with optional encryption
5. Service worker downloads the `.webblackbox` file via `chrome.downloads`

### Freeze

When a freeze condition is detected (uncaught JS error / unhandled rejection, or user marker by default):

1. Recorder evaluates freeze policy
2. Service worker receives freeze notification
3. Notification is debounced to avoid UI thrash under repeated failures
4. Session keeps recording until the user explicitly stops/exports

## Configuration

The extension uses `@webblackbox/protocol`'s `RecorderConfig` for all settings. Default values are defined in `DEFAULT_RECORDER_CONFIG`, then mode-specific runtime safety tuning is applied:

- Supported runtime profiles: `lite`, `full`
- `balanced` is not currently a shipped capture mode in this repo

- `lite`: lower sampling pressure + perf-trigger freeze disabled (`freezeOnNetworkFailure=false`, `freezeOnLongTaskSpike=false`)
  - page-side response-body sampling is disabled (`bodyCaptureMaxBytes=0`)
  - idle screenshots are disabled by default; enable `screenshotIdleMs` explicitly when needed
  - initial DOM/storage/screenshot capture is deferred briefly after start so the tab does not stall at record activation
  - hot listeners, observers, and page-side capture loops stay inactive until recording is enabled, even though `content.js` is loaded at `document_start`
- `full`: same perf-freeze disable + stricter sampling/body-capture limits
  - page-side heavy capture loops (SnapDOM screenshots, outerHTML snapshots, storage snapshots) are skipped to reduce main-thread impact
  - `injected` fetch/xhr/console patching is not enabled (CDP is the primary source in full mode)
  - screenshot/trace artifacts are still captured from the SW/CDP pipeline path

Body capture sizing note:

- Protocol baseline (`DEFAULT_RECORDER_CONFIG`) sets `bodyCaptureMaxBytes=0`.
- Extension `lite` keeps `bodyCaptureMaxBytes=0` and disables runtime screenshots unless screenshot cadence is explicitly enabled.
- Extension `full` defaults clamp CDP-side body capture to `128 KiB` for safer long-session behavior.
- Options can still override the full-mode cap per profile.

The SW ↔ offscreen pipeline path also uses ingest batching with chunked drain to reduce message round-trips and avoid giant postMessage payloads under high event volume.

Users can still tune other settings through the Options page.

## Requirements

- Chrome 125+
- Manifest V3
