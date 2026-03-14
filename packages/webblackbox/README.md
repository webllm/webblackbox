<p align="center">
  <a href="https://github.com/webllm/webblackbox"><img src="https://raw.githubusercontent.com/webllm/webblackbox/main/logo.png" alt="WebBlackbox" width="80" /></a>
</p>

<h1 align="center">webblackbox</h1>

<p align="center">
  Browser-side lite capture SDK — record, export, and embed WebBlackbox sessions in any web app.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/webblackbox"><img src="https://img.shields.io/npm/v/webblackbox.svg?color=f97316" alt="npm version" /></a>
  <a href="https://github.com/webllm/webblackbox/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/webblackbox?color=374151" alt="License" /></a>
  <a href="https://github.com/webllm/webblackbox"><img src="https://img.shields.io/badge/Part%20of-WebBlackbox-000?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iMyIgZmlsbD0iIzFhMWEyZSIvPjxwYXRoIGQ9Ik0zIDhoMi41bDIuNS00TDEwLjUgMTIgMTMgOCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZjk3MzE2IiBzdHJva2Utd2lkdGg9IjEuNSIvPjwvc3ZnPg==" alt="WebBlackbox" /></a>
</p>

---

The browser-side lite capture SDK for [WebBlackbox](https://github.com/webllm/webblackbox). Embed session recording directly in your web application — no Chrome extension required. Captures user interactions, console logs, network requests, DOM mutations, storage operations, screenshots, and more, then exports portable `.webblackbox` archives compatible with the full WebBlackbox Player.

## Installation

```bash
npm install webblackbox
```

## Quick Start

```ts
import { WebBlackboxLiteSdk } from "webblackbox/lite-sdk";

const sdk = new WebBlackboxLiteSdk({
  showIndicator: true,
  storage: "memory"
});

await sdk.start();

// ... user interacts with the page ...

const exported = await sdk.export({ stopCapture: true });
sdk.downloadArchive(exported);
await sdk.dispose();
```

## What's Included

| Export                            | Description                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `WebBlackboxLiteSdk`              | Main SDK class — start/stop/flush/export `.webblackbox` archives in-page                  |
| `LiteCaptureAgent`                | Reusable capture agent for input, DOM/storage snapshots, screenshots, and injected bridge |
| `installInjectedLiteCaptureHooks` | Runtime hooks for console/network/storage/error interception                              |
| `materializeLiteRawEvent`         | Shared lite raw-event materialization pipeline                                            |

### Entry Points

```ts
import { WebBlackboxLiteSdk } from "webblackbox/lite-sdk";
import { LiteCaptureAgent } from "webblackbox/lite-capture-agent";
import { installInjectedLiteCaptureHooks } from "webblackbox/injected-hooks";
import { materializeLiteRawEvent } from "webblackbox/lite-materializer";
```

## Optional IndexedDB Cache Encryption

When using `storage: "indexeddb"`, you can provide `pipelineStorageEncryptionKey` to encrypt cached chunk/blob payload bytes at rest.

```ts
import { derivePipelineStorageKey } from "@webblackbox/pipeline";
import { WebBlackboxLiteSdk } from "webblackbox/lite-sdk";

const derived = await derivePipelineStorageKey("cache-passphrase");

const sdk = new WebBlackboxLiteSdk({
  storage: "indexeddb",
  pipelineStorageEncryptionKey: derived.key
});
```

Persist `derived.salt` + `derived.iterations` using your own key-management policy if you need to reopen the same encrypted cache.

## Default Safety Tuning

`WebBlackboxLiteSdk` applies lite-focused runtime defaults to reduce long-session freezes and archive bloat:

| Setting                  | Default | Why                                                 |
| ------------------------ | ------- | --------------------------------------------------- |
| `freezeOnError`          | `true`  | Capture uncaught JS exceptions/rejections           |
| `freezeOnNetworkFailure` | `false` | Avoid noisy freezes from transient network issues   |
| `freezeOnLongTaskSpike`  | `false` | Avoid freezes from expected long tasks              |
| `mousemoveHz`            | `14`    | Lower frequency than full mode (20 Hz)              |
| `scrollHz`               | `10`    | Lower frequency than full mode (15 Hz)              |
| `domFlushMs`             | `160`   | Longer flush interval than full mode (100 ms)       |
| `bodyCaptureMaxBytes`    | `0`     | Disabled — keeps lite sessions page-thread friendly |

Override any of these through `options.config`.

### Export Policy Defaults

| Setting              | Default    |
| -------------------- | ---------- |
| `includeScreenshots` | `true`     |
| `maxArchiveBytes`    | 100 MB     |
| `recentWindowMs`     | 20 minutes |

## Extension Reuse

The Chrome extension (`apps/extension`) reuses this package in lite capture mode:

- **Content script** → `webblackbox/lite-capture-agent`
- **Injected script** → `webblackbox/injected-hooks`

This keeps capture logic centralized and shared across the SDK and extension lite mode.

## Testing

```bash
# Unit & integration tests
pnpm --filter webblackbox test

# End-to-end full-chain verification (extension → export → player)
pnpm --filter @webblackbox/extension e2e:fullchain:lite
pnpm --filter @webblackbox/extension e2e:fullchain:lite:reload
pnpm --filter @webblackbox/extension e2e:fullchain:full
```

## License

[MIT](https://github.com/webllm/webblackbox/blob/main/LICENSE)
