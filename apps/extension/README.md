# WebBlackbox Chrome Extension

Chrome Manifest V3 extension that records web sessions through scope-gated Lite page instrumentation or, in the explicit development/enterprise profile, the Chrome DevTools Protocol.

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

- Programmatically injected only into exact documents authorized for the user-started capture
- Captures user interaction events (click, input, scroll, keydown, etc.)
- Captures DOM mutations via MutationObserver
- Takes DOM snapshots at configured intervals
- Captures screenshots via SnapDOM
- Forwards events to the service worker via `chrome.runtime.connect` + `port.postMessage`

#### Injected Script (`injected.js`)

- Dynamically addressed web-accessible ESM module bootstrapped in the page context through an exact service-worker operation
- Intercepts console API calls (log, warn, error, etc.)
- Monitors storage operations (localStorage, sessionStorage, IndexedDB, cookies)
- Sends bounded, untrusted observation batches to the content script via `window.postMessage`; activation and drain control remain on the extension-owned direct module path

#### Offscreen Document

- Runs the `FlightRecorderPipeline` for event processing
- Handles chunking, compression, indexing, and blob storage
- Encrypts event chunks and blobs before IndexedDB persistence with a non-extractable, purpose-specific AES-GCM key that survives offscreen/service-worker restarts
- Purges the legacy plaintext cache (or an encrypted cache whose managed key was lost) instead of reopening unverifiable payloads
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

The Chrome Web Store package uses the `store-safe` profile:

| Permission      | Purpose                                                         |
| --------------- | --------------------------------------------------------------- |
| `activeTab`     | Temporary page access after the user starts recording           |
| `alarms`        | Restart-safe local session retention cleanup                    |
| `scripting`     | Programmatic capture injection after that user gesture          |
| `storage`       | Extension settings and session data                             |
| `offscreen`     | Pipeline processing in the background                           |
| `downloads`     | Archive file download                                           |
| `webNavigation` | Exact frame/document navigation identity and lifecycle tracking |

The separately packaged development/enterprise profile adds the following broader capabilities and is not the Web Store artifact:

| Permission      | Purpose                                                         |
| --------------- | --------------------------------------------------------------- |
| `debugger`      | CDP access for network, runtime, and page events                |
| `alarms`        | Restart-safe local session retention cleanup                    |
| `tabs`          | Tab information and URL access                                  |
| `scripting`     | Content script injection                                        |
| `storage`       | Extension settings and session data                             |
| `offscreen`     | Pipeline processing in background                               |
| `tabCapture`    | User-initiated tab media capture                                |
| `webRequest`    | Network request monitoring                                      |
| `downloads`     | Archive file download                                           |
| `webNavigation` | Exact frame/document navigation identity and lifecycle tracking |
| `<all_urls>`    | Content script injection on any page                            |

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
pnpm package:chrome:enterprise
pnpm verify
```

The build output is in the `build/` directory. The manifest is generated from `apps/extension/package.json` during the build, so there is no source `public/manifest.json` to keep in sync. Local `pnpm build` runs keep the stable development `key`, while `pnpm build:release` generates an unpacked, keyless `store-safe` build for store-parity checks. `pnpm package:chrome` always rebuilds with `--release --profile store-safe`, writes `dist/webblackbox-<version>-chrome.zip`, then reopens the ZIP and validates its release manifest. That Web Store artifact contains no `debugger`, `tabs`, `webRequest`, or `tabCapture` permission, no persistent host permissions, and no static content script registration. Tab recording remains available only in the explicit enterprise profile because it also requires that profile's CDP capability.

The broader profile is an explicit opt-in: `pnpm package:chrome:enterprise` writes `dist/webblackbox-<version>-enterprise-chrome.zip` with `--profile dev`. Do not upload that archive to the Chrome Web Store. The `pnpm package:*` commands are the source-hermetic release entrypoints because they clean and compile before packaging. A lower-level `node scripts/build-extension.mjs --package` invocation validates and packages an already compiled, closed-set `build/` directory; it defaults to `store-safe`, rejects unexpected residual files, and requires `--profile dev` for the broader archive. Packaging is pure Node.js, so it does not depend on a system `zip` binary. `pnpm verify` runs lint, typecheck, tests, and the store-safe packaging pipeline. You can override the ZIP path with `node scripts/build-extension.mjs --package --output ./dist/custom-name.zip`.

Build entries:

| Entry                          | Output                   | Description                      |
| ------------------------------ | ------------------------ | -------------------------------- |
| `src/sw/index.ts`              | `build/sw.js`            | Service worker                   |
| `src/content/index.ts`         | `build/content.js`       | Isolated-world content runtime   |
| `src/content/content-agent.ts` | `build/content-agent.js` | Scope-checking content bootstrap |
| `src/offscreen/index.ts`       | `build/offscreen.js`     | Offscreen document               |
| `src/popup/index.ts`           | `build/popup.js`         | Popup UI                         |
| `src/options/index.ts`         | `build/options.js`       | Options page                     |
| `src/sessions/index.ts`        | `build/sessions.js`      | Sessions page                    |
| `src/injected/index.ts`        | `build/injected.js`      | Direct MAIN-world ESM controller |

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
2. Service worker creates the session and initializes the recorder/pipeline, attaching CDP only when the selected profile and installed capability require it
3. Service worker authorizes and programmatically injects `content.js` into each exact in-scope document
4. In `lite` mode, the worker seeds a per-document capability and bootstraps the dynamic MAIN-world ESM module before activation commits
5. Content capture streams user events and DOM summaries; the MAIN-world module adds bounded console/network/storage observations and retains a bounded replay tail for exact stop drain
6. In capable development/enterprise installs, CDP provides network, runtime exception, page-navigation, and requested visual events
7. Service worker normalizes all events through the recorder
8. Delivery-aware batches are committed by the offscreen pipeline before the content sender is acknowledged
9. Pipeline chunks, indexes, encrypts, and stores events

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
  - content bootstrap is injected only after authorization, and hot listeners, observers, and page-side capture loops remain inactive until the exact activation commits
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
