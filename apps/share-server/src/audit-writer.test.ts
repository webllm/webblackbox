import { describe, expect, it } from "vitest";

import { BoundedAuditWriter } from "./audit-writer.js";

describe("BoundedAuditWriter", () => {
  it("serializes slow writes and rejects work above its hard queue capacity", async () => {
    const pendingWrites: Array<() => void> = [];
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const writer = new BoundedAuditWriter({
      append: () =>
        new Promise<void>((resolve) => {
          activeWrites += 1;
          maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
          pendingWrites.push(() => {
            activeWrites -= 1;
            resolve();
          });
        }),
      maxQueuedEntries: 2,
      queueWaitTimeoutMs: 1_000,
      writeTimeoutMs: 1_000,
      retryCooldownMs: 20
    });

    const first = writer.write("first\n");
    const second = writer.write("second\n");
    await waitFor(() => pendingWrites.length === 1);

    await expect(writer.write("overflow\n")).resolves.toEqual({
      status: "dropped",
      reason: "queue-capacity"
    });

    pendingWrites.shift()?.();
    await waitFor(() => pendingWrites.length === 1);
    pendingWrites.shift()?.();

    await expect(first).resolves.toEqual({ status: "written", recovered: false });
    await expect(second).resolves.toEqual({ status: "written", recovered: false });
    expect(maximumActiveWrites).toBe(1);
  });

  it("expires queued events instead of starting stale writes", async () => {
    let appendCalls = 0;
    const writer = new BoundedAuditWriter({
      append: async () => {
        appendCalls += 1;
        await delay(40);
      },
      maxQueuedEntries: 2,
      queueWaitTimeoutMs: 10,
      writeTimeoutMs: 100,
      retryCooldownMs: 20
    });

    const first = writer.write("first\n");
    const stale = writer.write("stale\n");

    await expect(first).resolves.toEqual({ status: "written", recovered: false });
    await expect(stale).resolves.toEqual({
      status: "dropped",
      reason: "queue-timeout"
    });
    expect(appendCalls).toBe(1);
  });

  it("bounds hung writes, drops followers, and recovers with one probe", async () => {
    let releaseHungWrite: (() => void) | undefined;
    let appendCalls = 0;
    const writer = new BoundedAuditWriter({
      append: (_line, signal) => {
        appendCalls += 1;
        if (appendCalls > 1) {
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          releaseHungWrite = resolve;
          signal.addEventListener("abort", () => undefined, { once: true });
        });
      },
      maxQueuedEntries: 3,
      queueWaitTimeoutMs: 100,
      writeTimeoutMs: 20,
      retryCooldownMs: 20
    });

    const hung = writer.write("hung\n");
    const follower = writer.write("follower\n");
    const anotherFollower = writer.write("another-follower\n");

    await expect(hung).resolves.toEqual({
      status: "failed",
      reason: "write-timeout"
    });
    await expect(follower).resolves.toEqual({
      status: "dropped",
      reason: "circuit-open"
    });
    await expect(anotherFollower).resolves.toEqual({
      status: "dropped",
      reason: "circuit-open"
    });

    await delay(25);
    await expect(writer.write("blocked-while-physical-write-hangs\n")).resolves.toEqual({
      status: "dropped",
      reason: "circuit-open"
    });
    expect(appendCalls).toBe(1);

    releaseHungWrite?.();
    await delay(25);
    await expect(writer.write("recovery-probe\n")).resolves.toEqual({
      status: "written",
      recovered: true
    });
    await expect(writer.write("after-recovery\n")).resolves.toEqual({
      status: "written",
      recovered: false
    });
    expect(appendCalls).toBe(3);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for test condition.");
    }
    await delay(1);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
