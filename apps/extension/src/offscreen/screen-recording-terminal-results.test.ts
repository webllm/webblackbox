import { describe, expect, it } from "vitest";

import { ScreenRecordingTerminalResultRegistry } from "./screen-recording-terminal-results.js";

type TestStopResult = Readonly<{
  recordingId: string;
  mime: string;
  chunkCount: number;
  size: number;
  durationMs: number;
  reason: string;
}>;

function result(recordingId: string, chunkCount: number): TestStopResult {
  return {
    recordingId,
    mime: "video/webm;codecs=vp9",
    chunkCount,
    size: chunkCount * 1_024,
    durationMs: chunkCount * 1_000,
    reason: "requested"
  };
}

describe("ScreenRecordingTerminalResultRegistry", () => {
  it("returns the complete successful result when a stop response is lost and retried", () => {
    const registry = new ScreenRecordingTerminalResultRegistry<TestStopResult>();
    const completed = result("VR-response-lost", 7);

    expect(registry.remember("S-session", completed.recordingId, completed)).toBe(completed);
    expect(registry.get("S-session", completed.recordingId)).toBe(completed);
    expect(registry.get("S-session", completed.recordingId)).toEqual({
      recordingId: "VR-response-lost",
      mime: "video/webm;codecs=vp9",
      chunkCount: 7,
      size: 7_168,
      durationMs: 7_000,
      reason: "requested"
    });
  });

  it("rejects reuse of a completed recording id until its terminal result expires", () => {
    let now = 1_000;
    const registry = new ScreenRecordingTerminalResultRegistry<TestStopResult>({
      ttlMs: 100,
      now: () => now
    });
    const completed = result("VR-completed", 2);
    registry.remember("S-session", completed.recordingId, completed);

    expect(() => registry.assertStartAllowed("S-session", completed.recordingId)).toThrow(
      "already completed"
    );

    now += 101;
    expect(() => registry.assertStartAllowed("S-session", completed.recordingId)).not.toThrow();
    expect(registry.get("S-session", completed.recordingId)).toBeUndefined();
  });

  it("evicts the oldest terminal result at its capacity limit", () => {
    const registry = new ScreenRecordingTerminalResultRegistry<TestStopResult>({ maxEntries: 2 });
    registry.remember("S-session", "VR-one", result("VR-one", 1));
    registry.remember("S-session", "VR-two", result("VR-two", 2));
    registry.remember("S-session", "VR-three", result("VR-three", 3));

    expect(registry.get("S-session", "VR-one")).toBeUndefined();
    expect(registry.get("S-session", "VR-two")?.chunkCount).toBe(2);
    expect(registry.get("S-session", "VR-three")?.chunkCount).toBe(3);
  });

  it("isolates equal recording ids by session and clears only the closed session", () => {
    const registry = new ScreenRecordingTerminalResultRegistry<TestStopResult>();
    const first = result("VR-shared", 1);
    const second = result("VR-shared", 9);
    registry.remember("S-one", first.recordingId, first);
    registry.remember("S-two", second.recordingId, second);

    expect(registry.get("S-one", "VR-shared")).toBe(first);
    expect(registry.get("S-two", "VR-shared")).toBe(second);

    registry.clearSession("S-one");

    expect(registry.get("S-one", "VR-shared")).toBeUndefined();
    expect(registry.get("S-two", "VR-shared")).toBe(second);
  });

  it("keeps the first successful result and rejects mismatched cache keys", () => {
    const registry = new ScreenRecordingTerminalResultRegistry<TestStopResult>();
    const first = result("VR-stable", 4);
    const conflicting = result("VR-stable", 8);

    registry.remember("S-session", first.recordingId, first);
    expect(registry.remember("S-session", conflicting.recordingId, conflicting)).toBe(first);
    expect(() => registry.remember("S-session", "VR-other", first)).toThrow("does not match");
  });

  it("validates registry bounds and its clock", () => {
    expect(() => new ScreenRecordingTerminalResultRegistry({ ttlMs: 0 })).toThrow(
      "TTL must be a positive safe integer"
    );
    expect(() => new ScreenRecordingTerminalResultRegistry({ maxEntries: 0 })).toThrow(
      "entry limit must be a positive safe integer"
    );
    const registry = new ScreenRecordingTerminalResultRegistry({
      now: () => Number.NaN
    });
    expect(() => registry.get("S-session", "VR-recording")).toThrow(
      "clock must return a finite number"
    );
  });
});
