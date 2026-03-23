import { describe, expect, it } from "vitest";

import { extractPerformanceBudgetNetworkSample } from "./performance-budget.js";

describe("performance-budget", () => {
  it("does not fail full-mode responses when ok is omitted but status is successful", () => {
    expect(
      extractPerformanceBudgetNetworkSample({
        requestId: "R-1",
        duration: 84,
        response: {
          status: 200
        }
      })
    ).toEqual({
      duration: 84,
      failed: false
    });
  });

  it("fails explicit lite-mode response failures", () => {
    expect(
      extractPerformanceBudgetNetworkSample({
        reqId: "R-2",
        duration: 120,
        status: 502,
        ok: false
      })
    ).toEqual({
      duration: 120,
      failed: true
    });
  });
});
