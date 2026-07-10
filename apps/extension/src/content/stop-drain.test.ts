import { describe, expect, it } from "vitest";

import type { RecordingStatusMessage } from "../shared/messages.js";
import {
  buildContentStopDrainedMessage,
  resolveContentStopDrainContext,
  stopDrainEventFields
} from "./stop-drain.js";

const STATUS: RecordingStatusMessage = {
  kind: "sw.recording-status",
  active: false,
  sid: "S-stop-drain",
  stopDrain: {
    token: "a".repeat(64),
    deadline: 2_000,
    documentUrl: "https://app.example.test/dashboard#bound"
  }
};

describe("content stop-drain passthrough", () => {
  it("freezes the capability URL into event batches and the acknowledgement", () => {
    const context = resolveContentStopDrainContext(STATUS, true, 1_000);

    expect(stopDrainEventFields(context, "https://app.example.test/changed")).toEqual({
      documentUrl: "https://app.example.test/dashboard#bound",
      stopDrainToken: "a".repeat(64)
    });
    expect(buildContentStopDrainedMessage(STATUS.sid, context)).toEqual({
      kind: "content.stop-drained",
      sid: "S-stop-drain",
      token: "a".repeat(64),
      documentUrl: "https://app.example.test/dashboard#bound"
    });
  });

  it("rejects active, child-frame, expired, and malformed capabilities", () => {
    expect(resolveContentStopDrainContext({ ...STATUS, active: true }, true, 1_000)).toBeNull();
    expect(resolveContentStopDrainContext(STATUS, false, 1_000)).toBeNull();
    expect(resolveContentStopDrainContext(STATUS, true, 2_001)).toBeNull();
    expect(
      resolveContentStopDrainContext(
        { ...STATUS, stopDrain: { ...STATUS.stopDrain!, documentUrl: "not a url" } },
        true,
        1_000
      )
    ).toBeNull();
    expect(buildContentStopDrainedMessage("", null)).toBeNull();
  });
});
