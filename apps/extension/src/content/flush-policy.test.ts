import { describe, expect, it } from "vitest";

import {
  CONTENT_EVENT_FLUSH_CHUNK,
  CONTENT_EVENT_FLUSH_IDLE_MS,
  CONTENT_EVENT_FLUSH_SOON_MS,
  CONTENT_EVENT_FLUSH_URGENT_MS,
  CONTENT_EVENT_FLUSH_URGENT_THRESHOLD,
  resolveContentEventFlushDelay
} from "./flush-policy.js";

describe("content flush policy", () => {
  it("uses an idle cadence for small queues", () => {
    expect(resolveContentEventFlushDelay(1)).toBe(CONTENT_EVENT_FLUSH_IDLE_MS);
    expect(resolveContentEventFlushDelay(CONTENT_EVENT_FLUSH_CHUNK - 1)).toBe(
      CONTENT_EVENT_FLUSH_IDLE_MS
    );
  });

  it("accelerates once the queue reaches a full chunk", () => {
    expect(resolveContentEventFlushDelay(CONTENT_EVENT_FLUSH_CHUNK)).toBe(
      CONTENT_EVENT_FLUSH_SOON_MS
    );
    expect(resolveContentEventFlushDelay(CONTENT_EVENT_FLUSH_URGENT_THRESHOLD - 1)).toBe(
      CONTENT_EVENT_FLUSH_SOON_MS
    );
  });

  it("uses the urgent cadence for forced or overloaded flushes", () => {
    expect(resolveContentEventFlushDelay(1, true)).toBe(CONTENT_EVENT_FLUSH_URGENT_MS);
    expect(resolveContentEventFlushDelay(CONTENT_EVENT_FLUSH_URGENT_THRESHOLD)).toBe(
      CONTENT_EVENT_FLUSH_URGENT_MS
    );
  });
});
