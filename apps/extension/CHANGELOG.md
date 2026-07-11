# @webblackbox/extension

## 0.6.0

### Minor Changes

- Added Lite-mode reload confirmation so users can choose whether to reload the current page before capture starts.
- Added Full visual capture modes for screenshots, tab recording, both, or none, with popup state persistence and export policy derived from the selected visual mode.
- Added full-mode tab screen recording capture, kept tab-scoped recordings active across same-tab navigations, and enforced enterprise site policy after navigation.
- Improved popup session recovery on reopen so active start/stop state is refreshed even if the initial service-worker push was missed.

### Patch Changes

- Replaced page-visible MAIN-world lifecycle control with a per-document 256-bit capability and
  dynamically addressed ESM bootstrap, kept observation messages bounded and untrusted, recovered
  surviving controllers after service-worker restarts, and reconciled a bounded replay tail during
  exact stop drain without injecting MAIN-world hooks in Full mode.
- Made Lite content delivery recoverable and exactly acknowledged across content/SW/offscreen
  reconnects, activation replacement, same-document navigation, and stop drain by persisting
  provenance receipts, retaining predecessor queues until their delivery barrier completes, and
  reporting bounded replay truncation as explicit degradation.
- Hardened remaining MV3 crash windows around same-document supersession, stopped-session removal,
  annotation checkpoints, runtime snapshot capacity, transient boot reads, offscreen creation/close,
  surviving pipeline policy identity, and screen-recording quiesce/chunk/finalization durability.
- Required dynamically addressed injected-module packages with the exact bootstrap/control export
  surface and made Chrome ZIP output byte-for-byte reproducible without timestamped directory entries.
- Removed the unreachable `tabCapture` permission from the store-safe Web Store profile; tab recording remains an explicit development/enterprise capability alongside CDP.
- Bound stop, purge, consent-expiry, and late raw-event work to the exact runtime identity: active
  runtime failures no longer cancel a pending same-tab replacement start, stop and purge tasks only
  coalesce for the same runtime object, supplied event session ids are authoritative, and an old
  finalizer cannot delete or leave a replacement capture fence permanently blocked.
- Kept active-runtime restoration provisional through pipeline resume, required injection and CDP
  bootstrap, interrupted-recording recovery, and requested screen-recording restart; capture and
  active content publication now begin only after one identity-fenced activation commit, while
  partial failures clean up once without briefly exposing an active session.
- Fenced Full and non-exact top-navigation work with runtime-bound monotonic revisions, so delayed
  policy, injection, CDP frame-tree, queued, and screen-recording work cannot revive an earlier
  same-URL navigation or operate on a same-tab replacement runtime; invalid roots now stop only the
  current navigation, while child-only global blocking keeps the valid root suspended for retry.
- Made the root Full-CDP bootstrap transactional and strict: debugger attach, the four baseline
  domains, requested subframe auto-attach, validated frame-tree priming, Runtime context reset, and
  explicitly requested full Performance metrics now fail startup or restoration closed, while
  DOMStorage remains best effort, child-only scope blocks suspend global artifacts without rejecting
  the root baseline, and initial Full artifacts run only after activation commits.
- Bound Full-CDP child and OOPIF readiness to exact attach tokens and document revisions: visual
  targets now block global artifacts until the four child baseline domains, recursive auto-attach,
  and a current validated child frame tree succeed; failed or denied children remain fail-closed,
  stale promises, Runtime contexts, request metadata, and delayed response-body follow-ups cannot
  affect reused session ids, malformed visual targets stop capture, child commands and startup settle
  waits are bounded, and detach or readiness recovery re-primes the current root before screen
  recording can restart.
- Made required root-page script injection strict across atomic start, runtime restore, and
  post-navigation recovery: isolated and Lite MAIN-world failures now roll back or stop only the
  current runtime, cancellation is fenced between worlds, and stale tasks cannot instrument or
  terminate a replacement session.
- Kept exact top and child document authorization alive across transient content-port disconnects,
  limiting disconnect cleanup to transport state while navigation, tab removal, and capture stop
  remain responsible for document-lifecycle revocation.
- Kept Full mode entirely out of the page MAIN world while retaining its isolated interaction
  agent: initial start, runtime restore, top navigation, content readiness, and dynamic child-frame
  injection now load `injected.js` only for Lite, without changing Lite's exact dual-world order.
- Made Lite coverage copy reflect installed runtime capabilities: store-safe UI now states that it
  records page-side signals without Chrome webRequest/browser-network metadata, while capable dev
  installs retain the browser-network baseline description and DOM snapshots are labeled nonvisual.
- Bound Lite navigation and browser-network capture to exact active Chrome documents and parent
  chains, closing the previous page synchronously, keeping committed replacements pending until
  exact dual-world injection and content readiness, and rejecting superseded completions, errors,
  and policy results without letting stale senders stop or reopen the replacement document.
- Made popup and options capture controls capability-aware: store-safe installs expose only Lite,
  Full visual choices require CDP, recording choices require tabCapture, and saving a reduced UI
  preserves supported hidden configuration instead of resetting it.
- Made new-session startup atomic: capability, policy, performance-budget, pipeline, injection, CDP,
  optional recording, and Lite reload prerequisites now complete behind a durable stopping tombstone
  before one required active checkpoint; cancellation or failure purges the provisional session
  identity-safely, while cleanup failures retain alarm-backed recovery state.
- Added manifest-and-API capability preflight before capture side effects, so unsupported Full,
  recording, page-injection, and Lite browser-network paths fail closed without stopping an
  existing session or creating an offscreen pipeline.
- Made active-session restart recovery transactional so any partial pipeline, content, CDP, or
  recording restoration is identity-safely removed, purged, and retained as a retryable stopping
  tombstone when cleanup cannot complete, without reviving a ghost recording checkpoint.
- Hardened generated-manifest verification to exact profile permission and host allowlists,
  rejecting duplicate, undeclared, or optional privileges before packaging.
- Made the isolated-world content bootstrap a per-document singleton, including lifecycle-safe
  suspension and resynchronization across back-forward cache restores, so repeated injection cannot
  duplicate agents, ports, listeners, or captured events.
- Stopped automatically replaying an export download after an ambiguous offscreen disconnect,
  preventing a lost acknowledgement from creating duplicate user-visible files.
- Required a successfully validated CDP frame tree before screenshots, DOM/storage snapshots,
  performance profiles, or tab-recording chunks can be captured, and invalidated in-flight
  artifacts across frame navigation until the current tree is safely re-primed.
- Preserved successful screen-recording stop results for bounded retries so a lost offscreen
  response cannot replace the real chunk count, size, duration, or reason with fabricated zeros.
- Bound dynamically navigated subframes to exact Chrome document identities before injection or
  Lite network capture, keeping replacement documents pending until an authenticated content
  sender is ready and preventing stale frame reuse from crossing capture scope.
- Made service-worker-to-offscreen event ingestion idempotent across response loss, reconnect
  retries, and offscreen recreation by retaining stable batch operation ids and reconciling each
  replay against the durable pipeline sequence watermark.
- Preserved Lite mode's final DOM, local-storage, and screenshot artifacts during stop with a
  short-lived, top-frame-bound drain capability, while keeping the synchronous capture fence and
  completing queued ingestion before the stopped checkpoint; count-only storage records are also
  normalized to the archive schema before persistence.
- Kept Lite webRequest wall-clock timestamps separate from monotonic capture time so delayed
  multi-source events retain a coherent replay timeline.
- Restored active and stopped runtime sessions safely across MV3 service-worker restarts, with
  strict policy-bound checkpoints and alarm-backed retention cleanup.
- Required an export passphrase in the popup and sessions UI and removed the automatic plaintext
  local-export override from the service-worker/offscreen pipeline bridge.
- Updated dependencies
  - @webblackbox/cdp-router@0.6.0
  - @webblackbox/pipeline@0.6.0
  - @webblackbox/protocol@0.6.0
  - @webblackbox/recorder@0.6.0
  - webblackbox@0.6.0

## 0.5.0

### Minor Changes

- Rolled up the post-0.4.5 privacy and export hardening work: store-safe capture defaults, enterprise capture-policy caps, origin-scoped recording, local export audit events, and full-mode capture policy application now work together across lite and full modes.
- Reworked local export UX and reliability with service-worker keepalive, runtime export acknowledgements, stalled-export feedback, privacy-finding alerts, optional passphrase downloads, and a popup toggle for sensitive-info alerting.

### Patch Changes

- Updated dependencies
  - @webblackbox/cdp-router@0.5.0
  - @webblackbox/pipeline@0.5.0
  - @webblackbox/protocol@0.5.0
  - @webblackbox/recorder@0.5.0
  - webblackbox@0.5.0

## 0.4.10

### Patch Changes

- Added a popup export option for sensitive-info alerts. The alert remains enabled by default, and disabling it suppresses popup privacy warning alerts for local exports.

## 0.4.9

### Patch Changes

- Made export passphrases optional for local downloads: leaving the passphrase prompt empty now downloads an unencrypted archive, while entering a passphrase still produces an AES-GCM encrypted archive.
- Updated dependencies
  - @webblackbox/pipeline@0.4.6

## 0.4.8

### Patch Changes

- Changed local exports to download even when the privacy scanner finds possible sensitive data, and surfaced those findings as a popup warning instead of a blocking export failure.

## 0.4.7

### Patch Changes

- Handled passphrase export button clicks directly so Chrome popup form submission quirks cannot leave the export dialog inert.

## 0.4.6

### Patch Changes

- Forced Chrome install/update detection onto a new extension package version after the popup export reliability fixes.

## 0.4.5

### Patch Changes

- Lazy-loaded the content capture agent and connected the content port only while recording, cutting idle page overhead when the extension is installed but inactive.
- Installed lite `webRequest` capture only for active lite sessions and gated injected hooks by recording state so page hooks stop emitting outside capture windows.
- Hardened full-mode CDP cleanup with attach-failure teardown, artifact capture timeouts, bounded request metadata retention, and CPU profiler shutdown safeguards.
- Expanded real-world product gates for lite/full capture, memory pressure, archive evidence, and headless runtime control paths.
- Updated dependencies
  - @webblackbox/cdp-router@0.4.5
  - @webblackbox/pipeline@0.4.5
  - @webblackbox/protocol@0.4.5
  - @webblackbox/recorder@0.4.5
  - webblackbox@0.4.5

## 0.4.4

### Patch Changes

- No extension runtime changes shipped in this release. The version bump keeps the extension aligned with the Player timeline and marker fixes in the 0.4.4 workspace release.
- Updated dependencies
  - @webblackbox/cdp-router@0.4.4
  - @webblackbox/pipeline@0.4.4
  - @webblackbox/protocol@0.4.4
  - @webblackbox/recorder@0.4.4
  - webblackbox@0.4.4

## 0.4.3

### Changed

- Hardened the full-chain end-to-end demo harness so Chrome startup retries with fresh profiles and ports, emits log-tail diagnostics when the DevTools endpoint never comes up, and tears down child browser processes more reliably.
- Removed the unused `cookies` and `activeTab` permissions from the generated extension manifest, and added regression coverage so release artifacts stay aligned with the extension's actual permission usage.

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
