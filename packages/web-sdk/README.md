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
