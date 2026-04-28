import { describe, expect, it, vi } from "vitest";

import { withCdpCommandTimeout } from "./cdp-command.js";

describe("cdp-command", () => {
  it("treats an undefined CDP result as a successful command", async () => {
    await expect(withCdpCommandTimeout(Promise.resolve(undefined), 1_000)).resolves.toEqual({
      ok: true,
      value: undefined
    });
  });

  it("returns a failed outcome when the command rejects", async () => {
    await expect(
      withCdpCommandTimeout(Promise.reject(new Error("cdp failed")), 1_000)
    ).resolves.toEqual({
      ok: false
    });
  });

  it("returns a failed outcome when the command times out", async () => {
    vi.useFakeTimers();

    try {
      const result = withCdpCommandTimeout(new Promise<string>(() => undefined), 250);

      await vi.advanceTimersByTimeAsync(250);

      await expect(result).resolves.toEqual({
        ok: false
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
