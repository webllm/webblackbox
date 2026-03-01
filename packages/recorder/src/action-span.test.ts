import { describe, expect, it } from "vitest";

import type { WebBlackboxEvent, WebBlackboxEventType } from "@webblackbox/protocol";

import { ActionSpanTracker } from "./action-span.js";

function createEvent(
  type: WebBlackboxEventType,
  mono: number,
  data: Record<string, unknown> = {},
  ref: WebBlackboxEvent["ref"] = {}
): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-action-test",
    tab: 1,
    t: mono,
    mono,
    type,
    id: `E-${mono}-${type}`,
    ref,
    data
  };
}

describe("ActionSpanTracker", () => {
  it("starts action spans from click and supported keydown events", () => {
    const tracker = new ActionSpanTracker(200);
    const click = tracker.assign(createEvent("user.click", 100));
    const keydownEnter = tracker.assign(
      createEvent("user.keydown", 200, {
        key: "Enter"
      })
    );
    const keydownOther = tracker.assign(
      createEvent("user.keydown", 300, {
        key: "Escape"
      })
    );

    expect(click.ref?.act).toBeDefined();
    expect(keydownEnter.ref?.act).toBeDefined();
    expect(keydownEnter.ref?.act).not.toBe(click.ref?.act);
    expect(keydownOther.ref?.act).toBeDefined();
  });

  it("attaches dependent network and dom events to active action by reqId", () => {
    const tracker = new ActionSpanTracker(100);
    const start = tracker.assign(createEvent("user.submit", 0));
    const request = tracker.assign(
      createEvent("network.request", 10, {
        reqId: "R-1"
      })
    );
    const domMutation = tracker.assign(
      createEvent(
        "dom.mutation",
        120,
        {},
        {
          req: "R-1"
        }
      )
    );
    const lateResponse = tracker.assign(
      createEvent(
        "network.finished",
        250,
        {},
        {
          req: "R-1"
        }
      )
    );
    expect(request.ref?.act).toBe(start.ref?.act);
    expect(domMutation.ref?.act).toBe(start.ref?.act);
    expect(lateResponse.ref?.act).toBe(start.ref?.act);
  });

  it("removes request-action mapping after terminal network events", () => {
    const tracker = new ActionSpanTracker(100);
    const start = tracker.assign(createEvent("user.marker", 0));

    tracker.assign(
      createEvent("network.request", 10, {
        reqId: "R-2"
      })
    );
    const finished = tracker.assign(
      createEvent("network.finished", 20, {
        reqId: "R-2"
      })
    );
    const lateEvent = tracker.assign(
      createEvent("network.finished", 400, {
        reqId: "R-2"
      })
    );

    expect(finished.ref?.act).toBe(start.ref?.act);
    expect(lateEvent.ref?.act).toBeUndefined();
  });

  it("returns original event for non-action events without mapping", () => {
    const tracker = new ActionSpanTracker(50);
    const event = createEvent("console.entry", 500, {
      text: "no action"
    });
    const assigned = tracker.assign(event);

    expect(assigned).toBe(event);
    expect(assigned.ref?.act).toBeUndefined();
  });
});
