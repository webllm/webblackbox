import { describe, expect, it } from "vitest";

import type { ContentDrainMessage } from "../shared/messages.js";
import {
  buildContentStopDrainedMessage,
  resolveContentStopDrainContext,
  stopDrainEventFields
} from "./stop-drain.js";

const ACTIVATION_ID = `a1_${"b".repeat(64)}` as ContentDrainMessage["activationId"];
const STATUS: ContentDrainMessage = {
  kind: "sw.content-drain",
  activationId: ACTIVATION_ID,
  sid: "S-stop-drain",
  token: "a".repeat(64),
  deadline: 2_000,
  documentUrl: "https://app.example.test/dashboard#bound"
};

describe("content stop-drain passthrough", () => {
  it("freezes the capability URL into event batches and the acknowledgement", () => {
    const context = resolveContentStopDrainContext(STATUS, 1_000);

    expect(stopDrainEventFields(context, "https://app.example.test/changed")).toEqual({
      documentUrl: "https://app.example.test/dashboard#bound",
      stopDrainToken: "a".repeat(64)
    });
    expect(buildContentStopDrainedMessage(context)).toEqual({
      kind: "content.stop-drained",
      activationId: ACTIVATION_ID,
      sid: "S-stop-drain",
      token: "a".repeat(64),
      documentUrl: "https://app.example.test/dashboard#bound",
      expectedArtifacts: [],
      emittedArtifacts: [],
      omittedArtifacts: [],
      degradationReasons: []
    });
  });

  it("accepts child-frame drains and rejects expired or malformed capabilities", () => {
    expect(resolveContentStopDrainContext(STATUS, 1_000)).not.toBeNull();
    expect(resolveContentStopDrainContext(STATUS, 2_001)).toBeNull();
    expect(
      resolveContentStopDrainContext({ ...STATUS, documentUrl: "not a url" }, 1_000)
    ).toBeNull();
    expect(buildContentStopDrainedMessage(null)).toBeNull();
  });
});
