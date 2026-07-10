import { describe, expect, it } from "vitest";

import { LatestTaskGate } from "./latest-task.js";

describe("LatestTaskGate", () => {
  it("allows only the most recently started task to commit", () => {
    const gate = new LatestTaskGate();
    const slowFirst = gate.begin();
    const fastSecond = gate.begin();

    expect(gate.isCurrent(fastSecond)).toBe(true);
    expect(gate.isCurrent(slowFirst)).toBe(false);
  });

  it("invalidates pending tasks when the selection is cleared", () => {
    const gate = new LatestTaskGate();
    const pending = gate.begin();

    gate.invalidate();

    expect(gate.isCurrent(pending)).toBe(false);
  });
});
