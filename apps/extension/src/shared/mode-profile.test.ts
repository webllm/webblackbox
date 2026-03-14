import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { MODE_PRODUCT_PROFILES, applyModeProductBoundary } from "./mode-profile.js";

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
  });

  it("documents only the shipped runtime profiles", () => {
    expect(Object.keys(MODE_PRODUCT_PROFILES).sort()).toEqual(["full", "lite"]);
  });
});
