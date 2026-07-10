import { describe, expect, it, vi } from "vitest";

import { readBoundedReadableStream } from "./bounded-stream-reader.js";

describe("bounded stream reader", () => {
  it("cancels the reader when accumulated bytes exceed a limit", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.enqueue(new Uint8Array(4));
      },
      cancel
    });

    await expect(
      readBoundedReadableStream(stream, {
        timeoutMs: 100,
        detail: "resource-test",
        maxBytes: 8,
        validateTotalBytes(totalBytes) {
          if (totalBytes > 6) {
            throw new Error("decoded byte limit");
          }
        }
      })
    ).rejects.toThrow("decoded byte limit");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a pending reader when decoding times out", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel
    });

    await expect(
      readBoundedReadableStream(stream, {
        timeoutMs: 5,
        detail: "timeout-test",
        maxBytes: 8,
        validateTotalBytes() {}
      })
    ).rejects.toThrow(/timed out after 5ms/i);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects on time even when underlying cancellation never settles", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel
    });
    const startedAt = Date.now();

    await expect(
      readBoundedReadableStream(stream, {
        timeoutMs: 5,
        detail: "hanging-cancel-test",
        maxBytes: 8,
        validateTotalBytes() {}
      })
    ).rejects.toThrow(/timed out after 5ms/i);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
