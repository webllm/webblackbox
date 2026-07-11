import {
  DEFAULT_CAPTURE_POLICY,
  type CapturePolicy,
  type SessionMetadata
} from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  assertMatchingPipelineStartIdentity,
  createPipelineStartIdentity
} from "./pipeline-start-identity.js";

const session: SessionMetadata = {
  sid: "S-1767225600001-start",
  tabId: 7,
  startedAt: 1_767_225_600_001,
  mode: "lite",
  url: "https://app.example",
  tags: []
};

const policy: CapturePolicy = {
  ...DEFAULT_CAPTURE_POLICY,
  redaction: {
    ...DEFAULT_CAPTURE_POLICY.redaction,
    redactHeaders: ["authorization"]
  }
};

describe("pipeline start identity", () => {
  it("is stable across plain-object key order", () => {
    const first = createPipelineStartIdentity({ sid: session.sid, session, capturePolicy: policy });
    const reordered = createPipelineStartIdentity({
      capturePolicy: { ...policy, categories: { ...policy.categories } },
      session: { ...session },
      sid: session.sid
    });

    expect(reordered).toBe(first);
    expect(
      createPipelineStartIdentity({
        sid: session.sid,
        session: {
          ...session,
          url: "https://app.example/after-navigation",
          title: "Updated title",
          tags: ["triaged"],
          endedAt: session.startedAt + 1_000
        },
        capturePolicy: policy
      })
    ).toBe(first);
  });

  it("fails closed when a surviving pipeline has a stale policy contract", () => {
    const first = createPipelineStartIdentity({ sid: session.sid, session, capturePolicy: policy });
    const stricter = createPipelineStartIdentity({
      sid: session.sid,
      session,
      capturePolicy: {
        ...policy,
        categories: { ...policy.categories, dom: "off" }
      }
    });

    expect(stricter).not.toBe(first);
    expect(() => assertMatchingPipelineStartIdentity(session.sid, first, stricter)).toThrow(
      /contract changed/
    );
  });

  it("rejects a request/session identity mismatch", () => {
    expect(() => createPipelineStartIdentity({ sid: "S-1767225600001-other", session })).toThrow(
      /does not match/
    );
  });
});
