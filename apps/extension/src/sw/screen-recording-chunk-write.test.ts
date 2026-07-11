import { describe, expect, it, vi } from "vitest";

import {
  ScreenRecordingChunkWriteLedger,
  ScreenRecordingFinalizationGate,
  retryScreenRecordingFinalization,
  runDurableScreenRecordingFinalization
} from "./screen-recording-chunk-write.js";

const HASH = "a".repeat(64);

describe("ScreenRecordingChunkWriteLedger", () => {
  it("coalesces concurrent exact retries and commits only after durable flush", async () => {
    const ledger = new ScreenRecordingChunkWriteLedger();
    let durableHash: string | undefined;
    let releaseFlush!: () => void;
    const flush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseFlush = resolve;
        })
    );
    const enqueueEvent = vi.fn(async () => undefined);
    const input = {
      index: 1,
      fingerprint: "video/webm:3",
      putBlob: vi.fn(async () => HASH),
      enqueueEvent,
      flush,
      getDurableHash: () => durableHash,
      commitDurable: (hash: string) => {
        durableHash = hash;
      }
    };

    const first = ledger.execute(input);
    const replay = ledger.execute(input);
    expect(replay).toBe(first);
    await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
    expect(durableHash).toBeUndefined();
    releaseFlush();
    await expect(Promise.all([first, replay])).resolves.toEqual([HASH, HASH]);
    expect(enqueueEvent).toHaveBeenCalledOnce();
    expect(durableHash).toBe(HASH);
  });

  it("retries only the durable flush after an event was already queued", async () => {
    const ledger = new ScreenRecordingChunkWriteLedger();
    let durableHash: string | undefined;
    const flush = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("flush failed"))
      .mockResolvedValue();
    const enqueueEvent = vi.fn(async () => undefined);
    const input = {
      index: 2,
      fingerprint: "video/webm:4",
      putBlob: vi.fn(async () => HASH),
      enqueueEvent,
      flush,
      getDurableHash: () => durableHash,
      commitDurable: (hash: string) => {
        durableHash = hash;
      }
    };

    await expect(ledger.execute(input)).rejects.toThrow("flush failed");
    await expect(ledger.execute(input)).resolves.toBe(HASH);
    expect(enqueueEvent).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(durableHash).toBe(HASH);
  });

  it("verifies a replay against the durable reference without queuing another event", async () => {
    const ledger = new ScreenRecordingChunkWriteLedger();
    const enqueueEvent = vi.fn(async () => undefined);

    await expect(
      ledger.execute({
        index: 3,
        fingerprint: "video/webm:5",
        putBlob: async () => HASH,
        enqueueEvent,
        flush: vi.fn(async () => undefined),
        getDurableHash: () => HASH,
        commitDurable: vi.fn()
      })
    ).resolves.toBe(HASH);
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it("rejects an index replay with different metadata or bytes", async () => {
    const ledger = new ScreenRecordingChunkWriteLedger();
    const first = {
      index: 4,
      fingerprint: "video/webm:6",
      putBlob: vi.fn(async () => HASH),
      enqueueEvent: vi.fn(async () => undefined),
      flush: vi.fn(async () => {
        throw new Error("retry later");
      }),
      getDurableHash: () => undefined,
      commitDurable: vi.fn()
    };

    await expect(ledger.execute(first)).rejects.toThrow("retry later");
    await expect(ledger.execute({ ...first, fingerprint: "video/webm:changed" })).rejects.toThrow(
      "different metadata"
    );
    await expect(
      ledger.execute({
        ...first,
        putBlob: async () => "b".repeat(64),
        flush: vi.fn(async () => undefined)
      })
    ).rejects.toThrow("different bytes");
  });
});

describe("ScreenRecordingFinalizationGate", () => {
  it("coalesces a terminal notification with the explicit stop response", async () => {
    const gate = new ScreenRecordingFinalizationGate();
    let release!: () => void;
    const operation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const terminalNotification = gate.run(operation);
    const stopResponse = gate.run(operation);
    expect(stopResponse).toBe(terminalNotification);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    release();
    await expect(Promise.all([terminalNotification, stopResponse])).resolves.toEqual([
      undefined,
      undefined
    ]);
  });

  it("allows one exact retry after a failed finalization", async () => {
    const gate = new ScreenRecordingFinalizationGate();
    const operation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("chunk flush failed"))
      .mockResolvedValue();

    await expect(gate.run(operation)).rejects.toThrow("chunk flush failed");
    await expect(gate.run(operation)).resolves.toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(2);
  });
});

describe("durable screen recording finalization", () => {
  it("withholds terminal evidence when the completed-recording checkpoint fails", async () => {
    let finalizing = false;
    const writeTerminalEvidence = vi.fn(async () => undefined);
    const commit = vi.fn();

    await expect(
      runDurableScreenRecordingFinalization({
        beginCompletionCheckpoint: () => {
          finalizing = true;
        },
        rollbackCompletionCheckpoint: () => {
          finalizing = false;
        },
        persistCompletionCheckpoint: () => Promise.reject(new Error("storage failed")),
        writeTerminalEvidence,
        commit
      })
    ).rejects.toThrow("storage failed");
    expect(finalizing).toBe(false);
    expect(writeTerminalEvidence).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("keeps the durable completion checkpoint when terminal evidence must retry", async () => {
    let finalizing = false;
    const commit = vi.fn();

    await expect(
      runDurableScreenRecordingFinalization({
        beginCompletionCheckpoint: () => {
          finalizing = true;
        },
        rollbackCompletionCheckpoint: () => {
          finalizing = false;
        },
        persistCompletionCheckpoint: async () => undefined,
        writeTerminalEvidence: () => Promise.reject(new Error("pipeline flush failed")),
        commit
      })
    ).rejects.toThrow("pipeline flush failed");
    expect(finalizing).toBe(true);
    expect(commit).not.toHaveBeenCalled();
  });

  it("commits only after the checkpoint and terminal evidence are durable", async () => {
    const order: string[] = [];

    await runDurableScreenRecordingFinalization({
      beginCompletionCheckpoint: () => {
        order.push("begin");
      },
      rollbackCompletionCheckpoint: vi.fn(),
      persistCompletionCheckpoint: async () => {
        order.push("checkpoint");
      },
      writeTerminalEvidence: async () => {
        order.push("terminal");
      },
      commit: () => {
        order.push("commit");
      }
    });

    expect(order).toEqual(["begin", "checkpoint", "terminal", "commit"]);
  });
});

describe("spontaneous screen recording finalization retry", () => {
  it("retries the exact terminal result with bounded backoff", async () => {
    const finalize = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockRejectedValueOnce(new Error("pipeline unavailable"))
      .mockResolvedValue();
    const waitForRetry = vi.fn(async () => undefined);

    await retryScreenRecordingFinalization({
      maxAttempts: 4,
      isCurrent: () => true,
      finalize,
      waitForRetry
    });
    expect(finalize).toHaveBeenCalledTimes(3);
    expect(waitForRetry.mock.calls).toEqual([[1], [2]]);
  });

  it("stops retrying after an explicit stop finalizes the recording", async () => {
    let current = true;
    const finalize = vi.fn(async () => {
      current = false;
      throw new Error("coalesced stop completed");
    });

    await expect(
      retryScreenRecordingFinalization({
        maxAttempts: 4,
        isCurrent: () => current,
        finalize,
        waitForRetry: vi.fn(async () => undefined)
      })
    ).resolves.toBeUndefined();
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("surfaces the last failure after the fixed attempt budget", async () => {
    const finalize = vi.fn(async () => {
      throw new Error("still unavailable");
    });

    await expect(
      retryScreenRecordingFinalization({
        maxAttempts: 3,
        isCurrent: () => true,
        finalize,
        waitForRetry: async () => undefined
      })
    ).rejects.toThrow("still unavailable");
    expect(finalize).toHaveBeenCalledTimes(3);
  });
});
