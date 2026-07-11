import { DEFAULT_CAPTURE_POLICY, type CapturePolicy } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  buildCdpFollowupRequestMetaKey,
  evaluateCdpTargetControlScopeEvent,
  isCdpFollowupClaimCurrent
} from "./cdp-event-followup.js";
import {
  canCaptureGlobalCdpArtifacts,
  createCdpCaptureScopeState,
  evaluateCdpCaptureScopeEvent,
  getCdpChildSessionClaim,
  primeCdpCaptureFrameTree
} from "./cdp-capture-scope.js";

function policy(): CapturePolicy {
  return {
    ...DEFAULT_CAPTURE_POLICY,
    consent: {
      ...DEFAULT_CAPTURE_POLICY.consent,
      grantedAt: "2020-01-01T00:00:00.000Z"
    },
    scope: {
      ...DEFAULT_CAPTURE_POLICY.scope,
      tabId: 7,
      origin: "https://app.example",
      includeSubframes: true,
      allowedOrigins: ["https://app.example"]
    }
  };
}

describe("CDP event follow-up claims", () => {
  it("keeps root follow-ups root-scoped", () => {
    const state = createCdpCaptureScopeState(policy(), 7, "https://app.example/home");

    expect(isCdpFollowupClaimCurrent(state, undefined, null)).toBe(true);
    expect(buildCdpFollowupRequestMetaKey("request", undefined, null)).toBe("request");
  });

  it("changes request identity and rejects a claim after child navigation", () => {
    const state = createCdpCaptureScopeState(policy(), 7, "https://app.example/home");
    evaluateCdpCaptureScopeEvent(state, "Target.attachedToTarget", {
      sessionId: "child",
      targetInfo: {
        targetId: "child-frame",
        type: "iframe",
        url: "https://app.example/frame"
      }
    });
    const before = getCdpChildSessionClaim(state, "child")!;
    const beforeKey = buildCdpFollowupRequestMetaKey("request", "child", before);

    evaluateCdpCaptureScopeEvent(
      state,
      "Page.frameNavigated",
      {
        frame: {
          id: "child-frame",
          parentId: "root",
          url: "https://app.example/next"
        }
      },
      "child"
    );
    const after = getCdpChildSessionClaim(state, "child")!;

    expect(isCdpFollowupClaimCurrent(state, "child", before)).toBe(false);
    expect(isCdpFollowupClaimCurrent(state, "child", after)).toBe(true);
    expect(buildCdpFollowupRequestMetaKey("request", "child", after)).not.toBe(beforeKey);
  });

  it("rejects an attachment claim after the session id is reused", () => {
    const state = createCdpCaptureScopeState(policy(), 7, "https://app.example/home");
    evaluateCdpCaptureScopeEvent(state, "Target.attachedToTarget", {
      sessionId: "child",
      targetInfo: {
        targetId: "first",
        type: "iframe",
        url: "https://app.example/first"
      }
    });
    const first = getCdpChildSessionClaim(state, "child")!;
    const firstKey = buildCdpFollowupRequestMetaKey("request", "child", first);

    evaluateCdpCaptureScopeEvent(state, "Target.detachedFromTarget", {
      sessionId: "child",
      targetId: "first"
    });
    evaluateCdpCaptureScopeEvent(state, "Target.attachedToTarget", {
      sessionId: "child",
      targetInfo: {
        targetId: "replacement",
        type: "iframe",
        url: "https://app.example/replacement"
      }
    });
    const replacement = getCdpChildSessionClaim(state, "child")!;

    expect(isCdpFollowupClaimCurrent(state, "child", first)).toBe(false);
    expect(isCdpFollowupClaimCurrent(state, "child", replacement)).toBe(true);
    expect(buildCdpFollowupRequestMetaKey("request", "child", replacement)).not.toBe(firstKey);
  });

  it("does not let an unknown nested Target source mutate child state", () => {
    const state = createCdpCaptureScopeState(policy(), 7, "https://app.example/home");
    evaluateCdpCaptureScopeEvent(state, "Target.attachedToTarget", {
      sessionId: "live-child",
      targetInfo: {
        targetId: "live-frame",
        type: "iframe",
        url: "https://app.example/live"
      }
    });
    const generation = state.generation;
    const childMutationRevision = state.childMutationRevision;

    expect(
      evaluateCdpTargetControlScopeEvent(
        state,
        "Target.attachedToTarget",
        {
          sessionId: "injected-child",
          targetInfo: {
            targetId: "injected-frame",
            type: "iframe",
            url: "https://app.example/injected"
          }
        },
        "unknown-parent"
      )
    ).toBeNull();
    expect(
      evaluateCdpTargetControlScopeEvent(
        state,
        "Target.detachedFromTarget",
        {
          sessionId: "live-child",
          targetId: "live-frame"
        },
        "unknown-parent"
      )
    ).toBeNull();
    expect(state.childSessions.has("injected-child")).toBe(false);
    expect(state.childSessions.has("live-child")).toBe(true);
    expect(state.generation).toBe(generation);
    expect(state.childMutationRevision).toBe(childMutationRevision);
  });

  it("accepts nested Target controls only while their parent session is live", () => {
    const state = createCdpCaptureScopeState(policy(), 7, "https://app.example/home");
    evaluateCdpCaptureScopeEvent(state, "Target.attachedToTarget", {
      sessionId: "parent",
      targetInfo: {
        targetId: "parent-frame",
        type: "iframe",
        url: "https://app.example/parent"
      }
    });

    expect(
      evaluateCdpTargetControlScopeEvent(
        state,
        "Target.attachedToTarget",
        {
          sessionId: "nested",
          targetInfo: {
            targetId: "nested-frame",
            type: "iframe",
            url: "https://app.example/nested"
          }
        },
        "parent"
      )?.childSessionClaim?.sessionId
    ).toBe("nested");

    evaluateCdpCaptureScopeEvent(state, "Target.detachedFromTarget", {
      sessionId: "parent",
      targetId: "parent-frame"
    });
    const generation = state.generation;
    expect(
      evaluateCdpTargetControlScopeEvent(
        state,
        "Target.detachedFromTarget",
        {
          sessionId: "nested",
          targetId: "nested-frame"
        },
        "parent"
      )
    ).toBeNull();
    expect(state.childSessions.has("nested")).toBe(false);
    expect(state.generation).toBe(generation);

    primeCdpCaptureFrameTree(state, {
      frame: { id: "root", url: "https://app.example/home" }
    });
    expect(canCaptureGlobalCdpArtifacts(state)).toBe(true);
  });

  it("does not let one live parent detach another parent's child", () => {
    const state = createCdpCaptureScopeState(policy(), 7, "https://app.example/home");

    for (const parent of ["parent-a", "parent-b"]) {
      evaluateCdpCaptureScopeEvent(state, "Target.attachedToTarget", {
        sessionId: parent,
        targetInfo: {
          targetId: `${parent}-frame`,
          type: "iframe",
          url: `https://app.example/${parent}`
        }
      });
    }

    evaluateCdpTargetControlScopeEvent(
      state,
      "Target.attachedToTarget",
      {
        sessionId: "nested-a",
        targetInfo: {
          targetId: "nested-a-frame",
          type: "iframe",
          url: "https://app.example/nested-a"
        }
      },
      "parent-a"
    );
    const generation = state.generation;

    expect(
      evaluateCdpTargetControlScopeEvent(
        state,
        "Target.detachedFromTarget",
        {
          sessionId: "nested-a",
          targetId: "nested-a-frame"
        },
        "parent-b"
      )
    ).toBeNull();
    expect(state.childSessions.has("nested-a")).toBe(true);
    expect(state.generation).toBe(generation);
  });
});
