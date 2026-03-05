import { describe, expect, it } from "vitest";

import {
  buildActionScopeIndex,
  extractReqIdFromEvent,
  inferEventScope,
  matchesScopeFilter,
  type EventScope
} from "./scope.js";

describe("scope utils", () => {
  it("infers iframe scope from cdp/frame markers", () => {
    expect(inferEventScope({ cdp: "session-1", frame: undefined })).toBe("iframe");
    expect(inferEventScope({ cdp: undefined, frame: "content-iframe" })).toBe("iframe");
    expect(inferEventScope({ cdp: undefined, frame: undefined })).toBe("main");
  });

  it("extracts request id from canonical fields", () => {
    expect(
      extractReqIdFromEvent({
        ref: { req: "R-1" },
        data: {}
      })
    ).toBe("R-1");

    expect(
      extractReqIdFromEvent({
        ref: undefined,
        data: { requestId: "R-2" }
      })
    ).toBe("R-2");

    expect(
      extractReqIdFromEvent({
        ref: undefined,
        data: { request: { requestId: "R-3" } }
      })
    ).toBe("R-3");
  });

  it("builds action scope index from full action span event ids", () => {
    const eventById = new Map([
      ["E-main-1", { cdp: undefined, frame: undefined, ref: undefined, data: {} }],
      [
        "E-main-2",
        { cdp: undefined, frame: undefined, ref: undefined, data: { requestId: "R-main" } }
      ],
      [
        "E-iframe-1",
        { cdp: undefined, frame: "content-iframe", ref: undefined, data: { requestId: "R-ifr" } }
      ],
      ["E-main-3", { cdp: undefined, frame: undefined, ref: { req: "R-ifr" }, data: {} }]
    ]);
    const requestScopeByReqId = new Map<string, EventScope>([
      ["R-main", "main"],
      ["R-ifr", "iframe"]
    ]);

    const index = buildActionScopeIndex(
      [
        {
          actId: "A-main",
          eventIds: ["E-main-1", "E-main-2"]
        },
        {
          // Simulates iframe-linked evidence appearing later in span event ids.
          actId: "A-iframe",
          eventIds: ["E-main-1", "E-main-3", "E-iframe-1"]
        }
      ],
      eventById,
      requestScopeByReqId
    );

    expect(index.get("A-main")).toBe("main");
    expect(index.get("A-iframe")).toBe("iframe");
  });

  it("matches scope filters", () => {
    expect(matchesScopeFilter("main", "all")).toBe(true);
    expect(matchesScopeFilter("iframe", "all")).toBe(true);
    expect(matchesScopeFilter("main", "main")).toBe(true);
    expect(matchesScopeFilter("iframe", "main")).toBe(false);
  });
});
