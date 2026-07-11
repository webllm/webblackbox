import { describe, expect, it, vi } from "vitest";

import {
  RuntimeTaskCoordinator,
  cancelOwnedRuntimeStart,
  resolveRuntimeEventOwner
} from "./runtime-identity.js";
import { deleteMapEntryIfSame } from "./runtime-state.js";

type Runtime = {
  sid: string;
  tabId: number;
};

describe("runtime identity ownership", () => {
  it("cancels only the start token owned by the stopped runtime", () => {
    const owned = { cancel: vi.fn() };
    const replacement = { cancel: vi.fn() };

    cancelOwnedRuntimeStart(owned);
    expect(owned.cancel).toHaveBeenCalledOnce();
    expect(replacement.cancel).not.toHaveBeenCalled();
    expect(() => cancelOwnedRuntimeStart(null)).not.toThrow();
  });

  it("uses a supplied sid as authoritative instead of falling back to the current tab runtime", () => {
    const retained = { sid: "old", tabId: 7 };
    const replacement = { sid: "new", tabId: 7 };
    const bySid = new Map([
      [retained.sid, retained],
      [replacement.sid, replacement]
    ]);
    const byTab = new Map([[replacement.tabId, replacement]]);

    expect(resolveRuntimeEventOwner(bySid, byTab, { sid: "old", tabId: 7 })).toBe(retained);
    expect(resolveRuntimeEventOwner(bySid, byTab, { sid: "missing", tabId: 7 })).toBeUndefined();
    expect(resolveRuntimeEventOwner(bySid, byTab, { sid: "old", tabId: 8 })).toBeUndefined();
    expect(resolveRuntimeEventOwner(bySid, byTab, { tabId: 7 })).toBe(replacement);
  });

  it("deletes a map entry only while the expected runtime still owns it", () => {
    const first = { sid: "first", tabId: 7 };
    const replacement = { sid: "replacement", tabId: 7 };
    const map = new Map<number, Runtime>([[7, replacement]]);

    expect(deleteMapEntryIfSame(map, 7, first)).toBe(false);
    expect(map.get(7)).toBe(replacement);
    expect(deleteMapEntryIfSame(map, 7, replacement)).toBe(true);
    expect(map.has(7)).toBe(false);
  });

  it("deduplicates only the same runtime task, not a same-tab replacement", async () => {
    const coordinator = new RuntimeTaskCoordinator<Runtime>();
    const first = { sid: "first", tabId: 7 };
    const replacement = { sid: "replacement", tabId: 7 };
    let releaseFirst: (() => void) | undefined;
    const firstTask = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        })
    );
    const replacementTask = vi.fn(async () => undefined);

    const pendingFirst = coordinator.run(first, firstTask);
    expect(coordinator.run(first, firstTask)).toBe(pendingFirst);
    const pendingReplacement = coordinator.run(replacement, replacementTask);

    await pendingReplacement;
    expect(firstTask).toHaveBeenCalledTimes(1);
    expect(replacementTask).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await pendingFirst;
  });
});
