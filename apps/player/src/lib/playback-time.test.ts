import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { normalizePlaybackEvents, shouldNormalizePlaybackToWallClock } from "./playback-time.js";

function event(id: string, mono: number, t: number): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-test",
    tab: 1,
    t,
    mono,
    type: "user.click",
    id,
    data: {}
  };
}

describe("normalizePlaybackEvents", () => {
  it("keeps coherent monotonic timelines unchanged", () => {
    const events = [event("E-2", 200, 1_700_000_000_200), event("E-1", 100, 1_700_000_000_100)];
    const normalized = normalizePlaybackEvents(events);

    expect(normalized.source).toBe("mono");
    expect(normalized.events.map((row) => [row.id, row.mono])).toEqual([
      ["E-1", 100],
      ["E-2", 200]
    ]);
  });

  it("uses wall-clock event times when mixed mono domains explode the playback range", () => {
    const events = [
      event("E-content", 250, 1_700_000_000_250),
      event("E-system", 1_700_000_000_500, 1_700_000_000_500),
      event("E-next", 320, 1_700_000_000_320)
    ];
    const normalized = normalizePlaybackEvents(events);

    expect(shouldNormalizePlaybackToWallClock(events)).toBe(true);
    expect(normalized.source).toBe("wall-clock");
    expect(normalized.events.map((row) => [row.id, row.mono])).toEqual([
      ["E-content", 1_700_000_000_250],
      ["E-next", 1_700_000_000_320],
      ["E-system", 1_700_000_000_500]
    ]);
  });
});
