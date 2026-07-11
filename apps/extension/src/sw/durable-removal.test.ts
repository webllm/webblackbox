import { describe, expect, it, vi } from "vitest";

import { commitDurableRemoval } from "./durable-removal.js";

describe("durable removal", () => {
  it("restores the retryable tombstone when the absence checkpoint fails", async () => {
    let present = true;
    const restore = vi.fn(() => {
      present = true;
    });

    await expect(
      commitDurableRemoval({
        remove: () => {
          present = false;
          return true;
        },
        persist: () => Promise.reject(new Error("storage set failed")),
        restore
      })
    ).rejects.toThrow("storage set failed");
    expect(present).toBe(true);
    expect(restore).toHaveBeenCalledOnce();
  });

  it("does not write an absence checkpoint for a stale identity", async () => {
    const persist = vi.fn(async () => undefined);

    await expect(
      commitDurableRemoval({ remove: () => false, persist, restore: vi.fn() })
    ).resolves.toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });
});
