import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { hasPlaybackEvents } from "./archive-health.js";

function event(type: WebBlackboxEvent["type"]): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-health",
    tab: 1,
    t: 1,
    mono: 1,
    type,
    id: `E-${type}`,
    privacy: {
      category: "system",
      sensitivity: "low",
      redacted: false
    },
    data: {}
  };
}

describe("archive-health", () => {
  it("treats config-only archives as having no playback events", () => {
    expect(hasPlaybackEvents([event("meta.config")])).toBe(false);
  });

  it("detects browser and user playback evidence", () => {
    expect(hasPlaybackEvents([event("meta.config"), event("screen.screenshot")])).toBe(true);
    expect(hasPlaybackEvents([event("meta.config"), event("user.click")])).toBe(true);
  });
});
