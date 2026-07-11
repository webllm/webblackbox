import { describe, expect, it, vi } from "vitest";

import {
  acknowledgeStopDrain,
  canAdmitStopDrainBatch,
  claimStopDrainEvent,
  closeStopDrain,
  commitStopDrainBatchClaims,
  commitStopDrainClaim,
  createStopDrainCapability,
  dropUnclaimableStopDrainOrdinaryEvent,
  getCommittedStopDrainArtifactTypes,
  isStopDrainClaimValid,
  releaseStopDrainClaim,
  resolveStopDrainTimeoutEvidence,
  runStopDrainBlobOperation,
  STOP_DRAIN_ORDINARY_EVENT_MAX
} from "./stop-drain.js";

const ACTIVATION_ID = `a1_${"b".repeat(64)}`;
const BATCH_ID = `b1_${"c".repeat(64)}`;
const DOCUMENT_ID = "document-1";

function fixture() {
  let now = 1_000;
  const runtime = {};
  const fence = { blocked: true };
  const capability = createStopDrainCapability({
    runtime,
    fence,
    activationId: ACTIVATION_ID,
    sid: "S-stop-drain",
    tabId: 42,
    frameId: 0,
    documentUrl: "https://app.example.test/dashboard",
    documentId: DOCUMENT_ID,
    deadline: 2_000,
    now: () => now,
    tokenFactory: () => "a".repeat(64)
  });
  const binding = {
    runtime,
    fence,
    token: capability.token,
    activationId: capability.activationId,
    sid: capability.sid,
    tabId: capability.tabId,
    frameId: 0,
    documentUrl: capability.documentUrl,
    documentId: capability.documentId,
    batchId: BATCH_ID,
    eventIndex: 0
  };

  return {
    capability,
    binding,
    runtime,
    fence,
    setNow: (value: number) => {
      now = value;
    }
  };
}

describe("stop-drain capability", () => {
  it("generates a fresh 256-bit token for each capability", () => {
    const first = createStopDrainCapability({
      runtime: {},
      fence: { blocked: true },
      activationId: ACTIVATION_ID,
      sid: "S-first",
      tabId: 1,
      frameId: 0,
      documentUrl: "https://app.example.test/first",
      documentId: "document-first",
      deadline: Date.now() + 1_000
    });
    const second = createStopDrainCapability({
      runtime: {},
      fence: { blocked: true },
      activationId: `a1_${"c".repeat(64)}`,
      sid: "S-second",
      tabId: 2,
      frameId: 7,
      documentUrl: "https://app.example.test/second",
      documentId: "document-second",
      deadline: Date.now() + 1_000
    });

    expect(first.token).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.token).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.token).not.toBe(first.token);
  });

  it("binds one stop artifact of each allowed type to the exact runtime and sender", () => {
    const { capability, binding, runtime, fence } = fixture();

    for (const [eventIndex, rawType] of [
      "snapshot",
      "localStorageSnapshot",
      "screenshot",
      "notice"
    ].entries()) {
      const eventBinding = { ...binding, eventIndex, rawType, reason: "stop" };
      const claim = claimStopDrainEvent(capability, eventBinding);

      expect(claim).not.toBeNull();
      expect(claimStopDrainEvent(capability, eventBinding)).toBe(claim);
      expect(
        claimStopDrainEvent(capability, {
          ...eventBinding,
          eventIndex: eventIndex + 100
        })
      ).toBeNull();
      expect(commitStopDrainClaim(claim!, runtime, fence)).toBe(true);
    }

    expect(getCommittedStopDrainArtifactTypes(capability)).toEqual([
      "snapshot",
      "localStorageSnapshot",
      "screenshot",
      "notice"
    ]);
  });

  it("checks exact draining batch admission without consuming an event claim", () => {
    const { capability, binding } = fixture();

    expect(canAdmitStopDrainBatch(capability, binding)).toBe(true);
    expect(capability.claims.size).toBe(0);
    expect(capability.ordinaryClaims.size).toBe(0);
  });

  it("does not let a missing or wrong batch token consume a later exact claim", () => {
    const { capability, binding } = fixture();

    expect(canAdmitStopDrainBatch(capability, { ...binding, token: undefined })).toBe(false);
    expect(canAdmitStopDrainBatch(capability, { ...binding, token: "wrong" })).toBe(false);
    expect(capability.claims.size).toBe(0);
    expect(capability.ordinaryClaims.size).toBe(0);

    expect(canAdmitStopDrainBatch(capability, binding)).toBe(true);
    expect(
      claimStopDrainEvent(capability, {
        ...binding,
        rawType: "snapshot",
        reason: "stop"
      })
    ).not.toBeNull();
  });

  it("rejects draining batch admission unless capability state and every binding are exact", () => {
    const variants = [
      { activationId: `a1_${"d".repeat(64)}` },
      { documentId: "document-other" },
      { token: "wrong" },
      { runtime: {} },
      { fence: { blocked: true } },
      { sid: "S-wrong" },
      { tabId: 43 },
      { frameId: 1 },
      { documentUrl: "https://app.example.test/other" }
    ];

    for (const variant of variants) {
      const { capability, binding } = fixture();
      expect(canAdmitStopDrainBatch(capability, { ...binding, ...variant })).toBe(false);
    }

    const invalid = fixture();
    invalid.capability.valid = false;
    expect(canAdmitStopDrainBatch(invalid.capability, invalid.binding)).toBe(false);

    const closed = fixture();
    closed.capability.accepting = false;
    expect(canAdmitStopDrainBatch(closed.capability, closed.binding)).toBe(false);

    const acknowledged = fixture();
    acknowledged.capability.acknowledged = true;
    expect(canAdmitStopDrainBatch(acknowledged.capability, acknowledged.binding)).toBe(false);

    const expired = fixture();
    expired.setNow(expired.capability.deadline + 1);
    expect(canAdmitStopDrainBatch(expired.capability, expired.binding)).toBe(false);
  });

  it("rejects the wrong activation, document, token, runtime, fence, sid, tab, frame, URL, reason, and type", () => {
    const variants = [
      { activationId: `a1_${"d".repeat(64)}` },
      { documentId: "document-other" },
      { token: "wrong" },
      { runtime: {} },
      { fence: { blocked: true } },
      { sid: "S-wrong" },
      { tabId: 43 },
      { frameId: 1 },
      { documentUrl: "https://app.example.test/other" },
      { reason: "interval" },
      { rawType: "indexedDbSnapshot" },
      { batchId: "not-a-content-event-batch" },
      { eventIndex: -1 }
    ];

    for (const variant of variants) {
      const { capability, binding } = fixture();
      expect(
        claimStopDrainEvent(capability, {
          ...binding,
          rawType: "snapshot",
          reason: "stop",
          ...variant
        })
      ).toBeNull();
    }
  });

  it("closes admission on ack while preserving already claimed in-flight work", () => {
    const { capability, binding, runtime, fence } = fixture();
    const claim = claimStopDrainEvent(capability, {
      ...binding,
      rawType: "snapshot",
      reason: "stop"
    });

    expect(claim).not.toBeNull();
    expect(acknowledgeStopDrain(capability, binding)).toBe(false);
    expect(commitStopDrainClaim(claim!, runtime, fence)).toBe(true);
    expect(acknowledgeStopDrain(capability, binding)).toBe(true);
    expect(acknowledgeStopDrain(capability, binding)).toBe(false);
    expect(
      claimStopDrainEvent(capability, {
        ...binding,
        rawType: "screenshot",
        reason: "stop"
      })
    ).toBeNull();
    expect(isStopDrainClaimValid(claim!, runtime, fence)).toBe(true);

    closeStopDrain(capability);
    expect(isStopDrainClaimValid(claim!, runtime, fence)).toBe(false);
  });

  it("admits bounded ordinary tail events captured no later than the frozen stop cutoff", () => {
    const { capability, binding } = fixture();

    expect(
      claimStopDrainEvent(capability, {
        ...binding,
        rawType: "click",
        reason: "interaction",
        capturedAt: capability.ordinaryEventCutoff
      })
    ).not.toBeNull();
    expect(
      claimStopDrainEvent(capability, {
        ...binding,
        rawType: "click",
        reason: "interaction",
        capturedAt: capability.ordinaryEventCutoff + 1
      })
    ).toBeNull();
  });

  it("drops an authenticated post-cutoff ordinary event without consuming artifact claims", () => {
    const { capability, binding } = fixture();
    const late = {
      ...binding,
      rawType: "click",
      reason: "interaction",
      capturedAt: capability.ordinaryEventCutoff + 1
    };

    expect(claimStopDrainEvent(capability, late)).toBeNull();
    expect(dropUnclaimableStopDrainOrdinaryEvent(capability, late)).toBe(true);
    expect(capability.droppedOrdinaryEvents).toBe(1);
    expect(
      claimStopDrainEvent(capability, {
        ...binding,
        eventIndex: 1,
        rawType: "snapshot",
        reason: "stop"
      })
    ).not.toBeNull();
  });

  it("releases a failed screenshot reservation so the exact event can retry", async () => {
    const { capability, binding, runtime, fence } = fixture();
    const eventBinding = {
      ...binding,
      rawType: "screenshot",
      reason: "stop"
    };
    const first = claimStopDrainEvent(capability, eventBinding)!;
    const failure = new Error("blob write failed");

    await expect(
      runStopDrainBlobOperation(first, runtime, fence, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(getCommittedStopDrainArtifactTypes(capability)).toEqual([]);
    expect(releaseStopDrainClaim(first)).toBe(true);
    expect(releaseStopDrainClaim(first)).toBe(false);

    const retry = claimStopDrainEvent(capability, eventBinding)!;
    expect(retry).not.toBe(first);
    await expect(
      runStopDrainBlobOperation(retry, runtime, fence, async () => "sha256:screenshot")
    ).resolves.toBe("sha256:screenshot");
    expect(commitStopDrainClaim(retry, runtime, fence)).toBe(true);
    expect(commitStopDrainClaim(retry, runtime, fence)).toBe(true);
    expect(releaseStopDrainClaim(retry)).toBe(false);
    expect(claimStopDrainEvent(capability, eventBinding)).toBeNull();
    expect(getCommittedStopDrainArtifactTypes(capability)).toEqual(["screenshot"]);
  });

  it("commits every reserved claim only after its exact batch becomes durable", () => {
    const { capability, binding, runtime, fence } = fixture();
    const snapshot = claimStopDrainEvent(capability, {
      ...binding,
      rawType: "snapshot",
      reason: "stop"
    })!;
    const ordinary = claimStopDrainEvent(capability, {
      ...binding,
      eventIndex: 1,
      rawType: "click",
      reason: "interaction",
      capturedAt: capability.ordinaryEventCutoff
    })!;

    expect(snapshot.status).toBe("reserved");
    expect(ordinary.status).toBe("reserved");
    expect(commitStopDrainBatchClaims(capability, BATCH_ID, runtime, fence)).toBe(true);
    expect(snapshot.status).toBe("committed");
    expect(ordinary.status).toBe("committed");
    expect(getCommittedStopDrainArtifactTypes(capability)).toEqual(["snapshot"]);
  });

  it("reports committed timeout artifacts as emitted and MAIN tail only as unconfirmed", () => {
    const { capability, binding, runtime, fence } = fixture();
    const snapshot = claimStopDrainEvent(capability, {
      ...binding,
      rawType: "snapshot",
      reason: "stop"
    })!;
    expect(commitStopDrainClaim(snapshot, runtime, fence)).toBe(true);

    expect(
      resolveStopDrainTimeoutEvidence(capability, [
        "main-world-tail",
        "snapshot",
        "localStorageSnapshot",
        "screenshot"
      ])
    ).toEqual({
      expectedArtifacts: ["main-world-tail", "snapshot", "localStorageSnapshot", "screenshot"],
      emittedArtifacts: ["snapshot"],
      omittedArtifacts: ["localStorageSnapshot", "screenshot"],
      unconfirmedArtifacts: ["main-world-tail"]
    });
  });

  it("does not commit a reservation through the wrong runtime, fence, or deadline", () => {
    const { capability, binding, runtime, fence, setNow } = fixture();
    const claim = claimStopDrainEvent(capability, {
      ...binding,
      rawType: "snapshot",
      reason: "stop"
    })!;

    expect(commitStopDrainClaim(claim, {}, fence)).toBe(false);
    expect(commitStopDrainClaim(claim, runtime, { blocked: true })).toBe(false);
    expect(claim.status).toBe("reserved");
    setNow(capability.deadline + 1);
    expect(commitStopDrainClaim(claim, runtime, fence)).toBe(false);
    expect(getCommittedStopDrainArtifactTypes(capability)).toEqual([]);
    expect(releaseStopDrainClaim(claim)).toBe(true);
  });

  it("bounds ordinary tail claims independently for each frame capability", () => {
    const { capability, binding } = fixture();

    for (let index = 0; index < STOP_DRAIN_ORDINARY_EVENT_MAX; index += 1) {
      expect(
        claimStopDrainEvent(capability, {
          ...binding,
          eventIndex: index,
          rawType: "click",
          reason: "interaction",
          capturedAt: capability.ordinaryEventCutoff
        })
      ).not.toBeNull();
    }

    expect(
      claimStopDrainEvent(capability, {
        ...binding,
        eventIndex: STOP_DRAIN_ORDINARY_EVENT_MAX,
        rawType: "submit",
        reason: "interaction",
        capturedAt: capability.ordinaryEventCutoff
      })
    ).toBeNull();
  });

  it("returns released ordinary reservations to the bounded tail budget", () => {
    const { capability, binding, runtime, fence } = fixture();
    const claims = Array.from({ length: STOP_DRAIN_ORDINARY_EVENT_MAX }, (_, eventIndex) =>
      claimStopDrainEvent(capability, {
        ...binding,
        eventIndex,
        rawType: "click",
        reason: "interaction",
        capturedAt: capability.ordinaryEventCutoff
      })
    );

    expect(claims.every(Boolean)).toBe(true);
    expect(capability.ordinaryClaims.size).toBe(STOP_DRAIN_ORDINARY_EVENT_MAX);
    expect(
      claimStopDrainEvent(capability, {
        ...binding,
        eventIndex: 0,
        rawType: "click",
        reason: "interaction",
        capturedAt: capability.ordinaryEventCutoff
      })
    ).toBe(claims[0]);
    expect(releaseStopDrainClaim(claims[0]!)).toBe(true);
    expect(capability.ordinaryClaims.size).toBe(STOP_DRAIN_ORDINARY_EVENT_MAX - 1);

    const replacement = claimStopDrainEvent(capability, {
      ...binding,
      eventIndex: STOP_DRAIN_ORDINARY_EVENT_MAX,
      rawType: "submit",
      reason: "interaction",
      capturedAt: capability.ordinaryEventCutoff
    });
    expect(replacement).not.toBeNull();
    expect(commitStopDrainClaim(replacement!, runtime, fence)).toBe(true);
    expect(capability.ordinaryClaims.size).toBe(STOP_DRAIN_ORDINARY_EVENT_MAX);
    expect(
      claimStopDrainEvent(capability, {
        ...binding,
        eventIndex: STOP_DRAIN_ORDINARY_EVENT_MAX + 1,
        rawType: "change",
        reason: "interaction",
        capturedAt: capability.ordinaryEventCutoff
      })
    ).toBeNull();
  });

  it("does not let a rejected ordinary event consume a later stop artifact claim", () => {
    const { capability, binding, runtime, fence } = fixture();
    const ordinary = claimStopDrainEvent(capability, {
      ...binding,
      rawType: "click",
      reason: "stop"
    });
    const snapshot = claimStopDrainEvent(capability, {
      ...binding,
      rawType: "snapshot",
      reason: "stop"
    });

    expect(ordinary).toBeNull();
    expect(snapshot).not.toBeNull();
    expect(commitStopDrainClaim(snapshot!, runtime, fence)).toBe(true);
    expect(acknowledgeStopDrain(capability, binding)).toBe(true);
    expect(isStopDrainClaimValid(snapshot!, runtime, fence)).toBe(true);
  });

  it("rejects expired claims and drops blob results that cross the deadline", async () => {
    const { capability, binding, runtime, fence, setNow } = fixture();
    const claim = claimStopDrainEvent(capability, {
      ...binding,
      rawType: "screenshot",
      reason: "stop"
    })!;
    const putBlob = vi.fn(async () => {
      setNow(2_001);
      return "sha256:orphan";
    });

    await expect(runStopDrainBlobOperation(claim, runtime, fence, putBlob)).resolves.toBeNull();
    expect(putBlob).toHaveBeenCalledOnce();
    expect(isStopDrainClaimValid(claim, runtime, fence)).toBe(false);
    expect(
      claimStopDrainEvent(capability, {
        ...binding,
        rawType: "snapshot",
        reason: "stop"
      })
    ).toBeNull();
  });

  it("does not start a blob operation after the fence binding changes", async () => {
    const { capability, binding, runtime, fence } = fixture();
    const claim = claimStopDrainEvent(capability, {
      ...binding,
      rawType: "localStorageSnapshot",
      reason: "stop"
    })!;
    const putBlob = vi.fn(async () => "sha256:blob");

    await expect(
      runStopDrainBlobOperation(claim, runtime, { blocked: true }, putBlob)
    ).resolves.toBeNull();
    expect(putBlob).not.toHaveBeenCalled();
    fence.blocked = false;
    expect(isStopDrainClaimValid(claim, runtime, fence)).toBe(false);
  });

  it("drops a blob result when finalization closes the capability in flight", async () => {
    const { capability, binding, runtime, fence } = fixture();
    const claim = claimStopDrainEvent(capability, {
      ...binding,
      rawType: "snapshot",
      reason: "stop"
    })!;

    await expect(
      runStopDrainBlobOperation(claim, runtime, fence, async () => {
        closeStopDrain(capability);
        return "sha256:orphan";
      })
    ).resolves.toBeNull();
  });
});
