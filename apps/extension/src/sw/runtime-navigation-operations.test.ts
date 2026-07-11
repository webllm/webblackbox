import { describe, expect, it, vi } from "vitest";

import {
  claimRuntimeNavigation,
  isRuntimeNavigationClaimCurrent
} from "./runtime-navigation-claim.js";
import {
  canOperateOnExpectedNavigationResource,
  didGuardedNavigationOperationRun,
  launchDetachedNavigationTask,
  reconcileAmbiguousNavigationResourceStart,
  resolveCdpNavigationPrimeOutcome,
  resolveTabNavigationSignal,
  runGuardedNavigationStep,
  runRuntimeNavigationTask
} from "./runtime-navigation-operations.js";

describe("runtime navigation operations", () => {
  it("creates one URL-complete signal for one tabs callback", () => {
    expect(
      resolveTabNavigationSignal({ url: "https://example.test/a", status: "complete" })
    ).toEqual({
      candidateUrl: "https://example.test/a",
      completed: true,
      source: "tabs-url-complete"
    });
    expect(resolveTabNavigationSignal({ status: "loading" })).toBeNull();
  });

  it("drops a delayed policy result after its claim becomes stale", async () => {
    const runtime = { navigationRevision: 0, open: true };
    const a1 = claimRuntimeNavigation(runtime, "tabs-url", "https://example.test/a");
    const isCurrent = () =>
      isRuntimeNavigationClaimCurrent(a1, runtime, (candidate) => candidate.open);
    let resolvePolicy!: (allowed: boolean) => void;
    const policy = new Promise<boolean>((resolve) => {
      resolvePolicy = resolve;
    });
    const pending = runGuardedNavigationStep(isCurrent, () => policy);

    claimRuntimeNavigation(runtime, "tabs-url", "https://example.test/b");
    claimRuntimeNavigation(runtime, "tabs-url", "https://example.test/a");
    resolvePolicy(true);

    await expect(pending).resolves.toEqual({ status: "stale", value: true });
  });

  it("does not run a queued operation after runtime replacement", async () => {
    const original = { navigationRevision: 0, open: true };
    const replacement = { navigationRevision: 0, open: true };
    const claim = claimRuntimeNavigation(original, "cdp-frame-navigated");
    const operation = vi.fn(async () => "must-not-run");

    await expect(
      runGuardedNavigationStep(
        () => isRuntimeNavigationClaimCurrent(claim, replacement, (candidate) => candidate.open),
        operation
      )
    ).resolves.toEqual({ status: "skipped" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("fails a current queued navigation closed without stopping a replacement", async () => {
    const failure = new Error("prime failed");
    const stopCurrent = vi.fn(async () => undefined);

    await expect(
      runRuntimeNavigationTask(
        () => true,
        async () => {
          throw failure;
        },
        stopCurrent
      )
    ).resolves.toEqual({ kind: "failed-closed", error: failure });
    expect(stopCurrent).toHaveBeenCalledOnce();

    let current = true;
    stopCurrent.mockClear();
    await expect(
      runRuntimeNavigationTask(
        () => current,
        async () => {
          current = false;
          throw failure;
        },
        stopCurrent
      )
    ).resolves.toEqual({ kind: "stale" });
    expect(stopCurrent).not.toHaveBeenCalled();
  });

  it.each(["frame-tree-prime", "stream-id", "offscreen-start", "offscreen-stop"])(
    "reports a stale %s completion for exact cleanup",
    async (value) => {
      let current = true;
      const pending = runGuardedNavigationStep(
        () => current,
        async () => {
          await Promise.resolve();
          current = false;
          return value;
        }
      );

      await expect(pending).resolves.toEqual({ status: "stale", value });
    }
  );

  it("requires exact cleanup whenever a guarded start operation actually ran", () => {
    expect(didGuardedNavigationOperationRun({ status: "skipped" })).toBe(false);
    expect(didGuardedNavigationOperationRun({ status: "current", value: "started" })).toBe(true);
    expect(didGuardedNavigationOperationRun({ status: "stale", value: "started" })).toBe(true);
  });

  it("does not let a hung detached restore hold the general runtime queue", async () => {
    const hungRestore = new Promise<void>(() => undefined);
    const oldRestoreStarted = vi.fn();
    const replacementRestore = vi.fn(async () => undefined);
    let runtimeQueue = Promise.resolve();

    runtimeQueue = runtimeQueue.then(() => {
      launchDetachedNavigationTask({
        run: async () => {
          oldRestoreStarted();
          await hungRestore;
        },
        onFailure: () => undefined
      });
    });
    runtimeQueue = runtimeQueue.then(() => {
      launchDetachedNavigationTask({
        run: replacementRestore,
        onFailure: () => undefined
      });
    });

    await runtimeQueue;
    await vi.waitFor(() => expect(replacementRestore).toHaveBeenCalledOnce());
    expect(oldRestoreStarted).toHaveBeenCalledOnce();
  });

  it("separates an invalid root from child-only global blocking", () => {
    expect(resolveCdpNavigationPrimeOutcome({ rootValid: false, globalCaptureReady: false })).toBe(
      "root-invalid"
    );
    expect(resolveCdpNavigationPrimeOutcome({ rootValid: true, globalCaptureReady: false })).toBe(
      "global-blocked"
    );
    expect(resolveCdpNavigationPrimeOutcome({ rootValid: true, globalCaptureReady: true })).toBe(
      "ready"
    );
  });

  it("rejects an expected recording after a replacement wins", () => {
    const oldRecording = { id: "old" };
    const replacement = { id: "new" };

    expect(canOperateOnExpectedNavigationResource(() => true, replacement, oldRecording)).toBe(
      false
    );
    expect(canOperateOnExpectedNavigationResource(() => false, oldRecording, oldRecording)).toBe(
      false
    );
    expect(canOperateOnExpectedNavigationResource(() => true, oldRecording, oldRecording)).toBe(
      true
    );
  });

  it("retains an ambiguous exact start identity when cleanup also fails", async () => {
    const recording = { id: "recording-a" };
    const stopFailure = new Error("stop response lost");

    await expect(
      reconcileAmbiguousNavigationResourceStart({
        current: () => recording,
        expected: recording,
        stop: async () => {
          throw stopFailure;
        }
      })
    ).resolves.toEqual({ kind: "retained", error: stopFailure });

    const stop = vi.fn(async () => undefined);
    await expect(
      reconcileAmbiguousNavigationResourceStart({
        current: () => ({ id: "replacement" }),
        expected: recording,
        stop
      })
    ).resolves.toEqual({ kind: "stale" });
    expect(stop).not.toHaveBeenCalled();
  });
});
