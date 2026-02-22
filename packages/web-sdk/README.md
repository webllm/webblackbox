# @webblackbox/web-sdk

Browser-side SDK for WebBlackbox Lite capture.

## What it includes

- `WebBlackboxLiteSdk`: start/stop/flush/export `.webblackbox` archives in-page.
- `LiteCaptureAgent`: reusable capture agent for input, DOM/storage snapshots, screenshots, and injected bridge.
- `installInjectedLiteCaptureHooks`: injected runtime hooks for console/network/storage/error capture.
- `materializeLiteRawEvent`: reusable lite raw-event materialization pipeline.

## Quick usage

```ts
import { WebBlackboxLiteSdk } from "@webblackbox/web-sdk/lite-sdk";

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

- `content` uses `@webblackbox/web-sdk/lite-capture-agent`
- `injected` uses `@webblackbox/web-sdk/injected-hooks`

This keeps capture logic centralized and shared across the SDK and extension lite mode.
