import { describe, expect, it, vi } from "vitest";

import {
  canFinalizeMainWorldRevocation,
  runBoundedMainWorldDeactivation
} from "./content-main-world-revocation.js";

describe("bounded MAIN-world revocation", () => {
  it("waits for a required exact deactivation", async () => {
    const deactivate = vi.fn(async () => undefined);

    await expect(
      runBoundedMainWorldDeactivation({ deactivate, timeoutMs: 1_000 })
    ).resolves.toEqual({ kind: "deactivated" });
    expect(deactivate).toHaveBeenCalledOnce();
  });

  it("reports a controller failure without rejecting the revocation task", async () => {
    const error = new Error("controller rejected");

    await expect(
      runBoundedMainWorldDeactivation({
        deactivate: () => Promise.reject(error),
        timeoutMs: 1_000
      })
    ).resolves.toEqual({ kind: "failed", error });
  });

  it("releases registry cleanup at the bounded deadline", async () => {
    vi.useFakeTimers();
    try {
      const pending = runBoundedMainWorldDeactivation({
        deactivate: () => new Promise<void>(() => undefined),
        timeoutMs: 250
      });

      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toEqual({ kind: "timed-out" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains authorization when an exact live document did not deactivate", () => {
    expect(
      canFinalizeMainWorldRevocation(
        { kind: "failed", error: new Error("executeScript failed") },
        true
      )
    ).toBe(false);
    expect(canFinalizeMainWorldRevocation({ kind: "timed-out" }, true)).toBe(false);
    expect(canFinalizeMainWorldRevocation({ kind: "timed-out" }, false)).toBe(true);
  });
});
