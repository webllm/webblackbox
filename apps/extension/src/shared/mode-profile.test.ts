import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  MODE_PRODUCT_PROFILES,
  applyModeProductBoundary,
  shouldInjectPageHooksForMode
} from "./mode-profile.js";

describe("mode-profile", () => {
  it("keeps lite on the lightweight runtime boundary", () => {
    const next = applyModeProductBoundary("lite", {
      ...DEFAULT_RECORDER_CONFIG,
      mode: "lite",
      freezeOnNetworkFailure: true,
      freezeOnLongTaskSpike: true,
      sampling: {
        ...DEFAULT_RECORDER_CONFIG.sampling,
        screenshotIdleMs: 12_000,
        bodyCaptureMaxBytes: 256 * 1024
      }
    });

    expect(next.freezeOnNetworkFailure).toBe(false);
    expect(next.freezeOnLongTaskSpike).toBe(false);
    expect(next.sampling.screenshotIdleMs).toBe(12_000);
    expect(next.sampling.bodyCaptureMaxBytes).toBe(0);
  });

  it("preserves full browser-side capture knobs while disabling perf-trigger freeze", () => {
    const next = applyModeProductBoundary("full", {
      ...DEFAULT_RECORDER_CONFIG,
      mode: "full",
      freezeOnNetworkFailure: true,
      freezeOnLongTaskSpike: true,
      sampling: {
        ...DEFAULT_RECORDER_CONFIG.sampling,
        screenshotIdleMs: 12_000,
        bodyCaptureMaxBytes: 128 * 1024
      }
    });

    expect(next.freezeOnNetworkFailure).toBe(false);
    expect(next.freezeOnLongTaskSpike).toBe(false);
    expect(next.sampling.screenshotIdleMs).toBe(12_000);
    expect(next.sampling.bodyCaptureMaxBytes).toBe(128 * 1024);
    expect(next.capturePolicy?.mode).toBe("debug");
    expect(next.capturePolicy?.unmaskPolicySource).toBe("extension-managed");
    expect(next.capturePolicy?.categories.screenshots).toBe("allow");
    expect(next.capturePolicy?.categories.cdp).toBe("safe-subset");
  });

  it("preserves explicit full CDP policy for deeper local diagnostics", () => {
    const next = applyModeProductBoundary("full", {
      ...DEFAULT_RECORDER_CONFIG,
      capturePolicy: {
        ...DEFAULT_RECORDER_CONFIG.capturePolicy!,
        mode: "lab",
        categories: {
          ...DEFAULT_RECORDER_CONFIG.capturePolicy!.categories,
          cdp: "full"
        }
      }
    });

    expect(next.capturePolicy?.mode).toBe("lab");
    expect(next.capturePolicy?.categories.screenshots).toBe("allow");
    expect(next.capturePolicy?.categories.cdp).toBe("full");
  });

  it("injects page hooks for both shipped capture modes", () => {
    expect(shouldInjectPageHooksForMode("lite")).toBe(true);
    expect(shouldInjectPageHooksForMode("full")).toBe(true);
  });

  it("documents only the shipped runtime profiles", () => {
    expect(Object.keys(MODE_PRODUCT_PROFILES).sort()).toEqual(["full", "lite"]);
  });
});
