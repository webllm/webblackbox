import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { resolveModeRecorderConfig } from "./recorder-config.js";

describe("recorder-config", () => {
  it("applies the full capture boundary when no stored options exist", () => {
    const next = resolveModeRecorderConfig(
      "full",
      {
        ...DEFAULT_RECORDER_CONFIG,
        mode: "full",
        freezeOnNetworkFailure: true,
        freezeOnLongTaskSpike: true,
        sampling: {
          ...DEFAULT_RECORDER_CONFIG.sampling,
          screenshotIdleMs: 12_000,
          bodyCaptureMaxBytes: 128 * 1024
        }
      },
      undefined
    );

    expect(next.mode).toBe("full");
    expect(next.freezeOnNetworkFailure).toBe(false);
    expect(next.freezeOnLongTaskSpike).toBe(false);
    expect(next.capturePolicy?.mode).toBe("debug");
    expect(next.capturePolicy?.unmaskPolicySource).toBe("extension-managed");
    expect(next.capturePolicy?.categories.screenshots).toBe("allow");
    expect(next.capturePolicy?.categories.cdp).toBe("safe-subset");
    expect(next.sampling.screenshotIdleMs).toBe(12_000);
    expect(next.sampling.bodyCaptureMaxBytes).toBe(128 * 1024);
  });

  it("merges stored options before applying the full capture boundary", () => {
    const next = resolveModeRecorderConfig(
      "full",
      {
        ...DEFAULT_RECORDER_CONFIG,
        mode: "full",
        sampling: {
          ...DEFAULT_RECORDER_CONFIG.sampling,
          screenshotIdleMs: 12_000,
          bodyCaptureMaxBytes: 128 * 1024
        }
      },
      {
        sampling: {
          screenshotIdleMs: 6_000
        }
      }
    );

    expect(next.mode).toBe("full");
    expect(next.sampling.screenshotIdleMs).toBe(6_000);
    expect(next.sampling.bodyCaptureMaxBytes).toBe(128 * 1024);
    expect(next.capturePolicy?.categories.screenshots).toBe("allow");
    expect(next.capturePolicy?.categories.cdp).toBe("safe-subset");
  });

  it("keeps lite options inside the lightweight capture boundary without stored options", () => {
    const next = resolveModeRecorderConfig(
      "lite",
      {
        ...DEFAULT_RECORDER_CONFIG,
        mode: "lite",
        sampling: {
          ...DEFAULT_RECORDER_CONFIG.sampling,
          bodyCaptureMaxBytes: 128 * 1024
        }
      },
      null
    );

    expect(next.mode).toBe("lite");
    expect(next.sampling.bodyCaptureMaxBytes).toBe(0);
  });
});
