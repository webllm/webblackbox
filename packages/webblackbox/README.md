# webblackbox

Browser-side SDK for WebBlackbox Lite capture.

## What it includes

- `WebBlackboxLiteSdk`: start/stop/flush/export `.webblackbox` archives in-page.
- `LiteCaptureAgent`: reusable capture agent for input, DOM/storage snapshots, screenshots, and injected bridge.
- `installInjectedLiteCaptureHooks`: injected runtime hooks for console/network/storage/error capture.
- `materializeLiteRawEvent`: reusable lite raw-event materialization pipeline.

## Quick usage

```ts
import { WebBlackboxLiteSdk } from "webblackbox/lite-sdk";

const sdk = new WebBlackboxLiteSdk({
  showIndicator: true,
  storage: "memory"
});

await sdk.start();

// ... interact with page ...

const exported = await sdk.export({ stopCapture: true });
sdk.downloadArchive(exported);
await sdk.dispose();
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

- Keeps `freezeOnError=true` for uncaught JS exceptions/rejections
- Defaults `freezeOnNetworkFailure=false` and `freezeOnLongTaskSpike=false`
- Uses lower-frequency sampling defaults (`mousemoveHz=14`, `scrollHz=10`, `domFlushMs=160`)
- Disables response-body capture by default (`bodyCaptureMaxBytes=0`) so lite sessions stay page-thread friendly

You can still override these through `options.config`.

`export()` also applies default export policy (override-able per call):

- `includeScreenshots: true`
- `maxArchiveBytes: 100 * 1024 * 1024` (100MB)
- `recentWindowMs: 20 * 60 * 1000` (recent 20 minutes)

## Extension reuse

`apps/extension` reuses this package in lite start flow:

- `content` uses `webblackbox/lite-capture-agent`
- `injected` uses `webblackbox/injected-hooks`

This keeps capture logic centralized and shared across the SDK and extension lite mode.

## Tests

- Unit tests:
  - `src/lite-materializer.test.ts`
  - `src/injected-hooks.test.ts`
- Integration tests:
  - `src/lite-sdk.test.ts` (start/stop/ingest/export archive flow)

Run with:

```bash
pnpm --filter webblackbox test
```

For end-to-end full-chain verification (extension -> export -> player), use extension scripts:

```bash
pnpm --filter @webblackbox/extension e2e:fullchain:lite
pnpm --filter @webblackbox/extension e2e:fullchain:lite:reload
pnpm --filter @webblackbox/extension e2e:fullchain:full
```
