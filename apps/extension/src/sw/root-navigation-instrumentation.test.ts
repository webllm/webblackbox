import { describe, expect, it, vi } from "vitest";

import { runRootNavigationInstrumentationTransaction } from "./root-navigation-instrumentation.js";
import {
  claimRuntimeNavigation,
  isRuntimeNavigationClaimCurrent
} from "./runtime-navigation-claim.js";

describe("root navigation instrumentation transaction", () => {
  it("stops the current runtime after injection fails and skips all continuation", async () => {
    const injectionFailure = new Error("root content injection failed");
    const stopCurrent = vi.fn(async () => undefined);
    const continueAfterInjection = vi.fn(async () => undefined);

    await expect(
      runRootNavigationInstrumentationTransaction({
        isCurrent: () => true,
        inject: async () => {
          throw injectionFailure;
        },
        stopCurrent,
        continueAfterInjection
      })
    ).resolves.toEqual({ kind: "failed-closed", error: injectionFailure });
    expect(stopCurrent).toHaveBeenCalledOnce();
    expect(continueAfterInjection).not.toHaveBeenCalled();
  });

  it("does not stop a replacement runtime after stale injection rejects", async () => {
    let current = true;
    const stopCurrent = vi.fn(async () => undefined);
    const continueAfterInjection = vi.fn(async () => undefined);

    await expect(
      runRootNavigationInstrumentationTransaction({
        isCurrent: () => current,
        inject: async () => {
          current = false;
          throw new Error("old document disappeared");
        },
        stopCurrent,
        continueAfterInjection
      })
    ).resolves.toEqual({ kind: "stale" });
    expect(stopCurrent).not.toHaveBeenCalled();
    expect(continueAfterInjection).not.toHaveBeenCalled();
  });

  it("turns an injection cancellation fence into a stale result", async () => {
    let current = true;
    const stopCurrent = vi.fn(async () => undefined);
    const continueAfterInjection = vi.fn(async () => undefined);

    await expect(
      runRootNavigationInstrumentationTransaction({
        isCurrent: () => current,
        inject: async (assertCurrent) => {
          current = false;
          assertCurrent();
        },
        stopCurrent,
        continueAfterInjection
      })
    ).resolves.toEqual({ kind: "stale" });
    expect(stopCurrent).not.toHaveBeenCalled();
    expect(continueAfterInjection).not.toHaveBeenCalled();
  });

  it("does not stop a newer navigation in the same runtime after stale injection rejects", async () => {
    const runtime = { navigationRevision: 0, open: true };
    const oldNavigation = claimRuntimeNavigation(
      runtime,
      "tabs-url-complete",
      "https://example.test/a"
    );
    const stopCurrent = vi.fn(async () => undefined);

    await expect(
      runRootNavigationInstrumentationTransaction({
        isCurrent: () =>
          isRuntimeNavigationClaimCurrent(oldNavigation, runtime, (candidate) => candidate.open),
        inject: async () => {
          claimRuntimeNavigation(runtime, "tabs-url", "https://example.test/b");
          throw new Error("old document disappeared");
        },
        stopCurrent,
        continueAfterInjection: async () => undefined
      })
    ).resolves.toEqual({ kind: "stale" });
    expect(stopCurrent).not.toHaveBeenCalled();
  });

  it("continues only after successful current injection", async () => {
    const steps: string[] = [];

    await expect(
      runRootNavigationInstrumentationTransaction({
        isCurrent: () => true,
        inject: async (assertCurrent) => {
          assertCurrent();
          steps.push("inject");
        },
        stopCurrent: async () => undefined,
        continueAfterInjection: async (assertCurrent) => {
          assertCurrent();
          steps.push("cdp");
          assertCurrent();
          steps.push("notify");
        }
      })
    ).resolves.toEqual({ kind: "completed" });
    expect(steps).toEqual(["inject", "cdp", "notify"]);
  });

  it("abandons continuation without stopping when the runtime is replaced", async () => {
    let current = true;
    const stopCurrent = vi.fn(async () => undefined);

    await expect(
      runRootNavigationInstrumentationTransaction({
        isCurrent: () => current,
        inject: async () => undefined,
        stopCurrent,
        continueAfterInjection: async (assertCurrent) => {
          current = false;
          assertCurrent();
        }
      })
    ).resolves.toEqual({ kind: "stale" });
    expect(stopCurrent).not.toHaveBeenCalled();
  });

  it("propagates a current continuation failure for caller-level reporting", async () => {
    const cdpFailure = new Error("CDP restore failed");

    await expect(
      runRootNavigationInstrumentationTransaction({
        isCurrent: () => true,
        inject: async () => undefined,
        stopCurrent: async () => undefined,
        continueAfterInjection: async () => {
          throw cdpFailure;
        }
      })
    ).rejects.toBe(cdpFailure);
  });
});
