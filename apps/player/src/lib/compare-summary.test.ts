import { describe, expect, it } from "vitest";

import { formatCompareSummary } from "./compare-summary.js";

describe("formatCompareSummary", () => {
  it("formats totals and top type deltas", () => {
    const text = formatCompareSummary({
      leftSessionId: "S-left",
      rightSessionId: "S-right",
      leftSid: "S-left",
      rightSid: "S-right",
      eventDelta: 12,
      errorDelta: -3,
      requestDelta: 4,
      durationDeltaMs: 1250,
      typeDeltas: [
        {
          type: "network.request",
          left: 10,
          right: 14,
          delta: 4
        }
      ],
      endpointRegressions: []
    });

    expect(text).toContain("Session Compare");
    expect(text).toContain("events: +12");
    expect(text).toContain("errors: -3");
    expect(text).toContain("duration: +1.25s");
    expect(text).toContain("network.request");
  });

  it("formats endpoint regression rows", () => {
    const text = formatCompareSummary({
      leftSessionId: "S-left",
      rightSessionId: "S-right",
      leftSid: "S-left",
      rightSid: "S-right",
      eventDelta: 0,
      errorDelta: 0,
      requestDelta: 0,
      durationDeltaMs: 0,
      typeDeltas: [],
      endpointRegressions: [
        {
          endpoint: "/api/checkout",
          method: "POST",
          leftCount: 6,
          rightCount: 9,
          countDelta: 3,
          leftFailed: 1,
          rightFailed: 4,
          failedDelta: 3,
          leftFailureRate: 1 / 6,
          rightFailureRate: 4 / 9,
          failureRateDelta: 4 / 9 - 1 / 6,
          leftP95DurationMs: 420,
          rightP95DurationMs: 810,
          p95DurationDeltaMs: 390
        }
      ]
    });

    expect(text).toContain("Endpoint Regressions");
    expect(text).toContain("POST /api/checkout");
    expect(text).toContain("count +3");
    expect(text).toContain("p95 +390ms");
  });
});
