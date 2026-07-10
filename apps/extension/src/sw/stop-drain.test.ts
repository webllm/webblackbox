import { describe, expect, it, vi } from "vitest";

import {
  acknowledgeStopDrain,
  claimStopDrainEvent,
  closeStopDrain,
  createStopDrainCapability,
  isStopDrainClaimValid,
  runStopDrainBlobOperation
} from "./stop-drain.js";

function fixture() {
  let now = 1_000;
  const runtime = {};
  const fence = { blocked: true };
  const capability = createStopDrainCapability({
    runtime,
    fence,
    sid: "S-stop-drain",
    tabId: 42,
    documentUrl: "https://app.example.test/dashboard",
    deadline: 2_000,
    now: () => now,
    tokenFactory: () => "a".repeat(64)
  });
  const binding = {
    runtime,
    fence,
    token: capability.token,
    sid: capability.sid,
    tabId: capability.tabId,
    frameId: 0,
    documentUrl: capability.documentUrl
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
      sid: "S-first",
      tabId: 1,
      documentUrl: "https://app.example.test/first",
      deadline: Date.now() + 1_000
    });
    const second = createStopDrainCapability({
      runtime: {},
      fence: { blocked: true },
      sid: "S-second",
      tabId: 2,
      documentUrl: "https://app.example.test/second",
      deadline: Date.now() + 1_000
    });

    expect(first.token).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.token).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.token).not.toBe(first.token);
  });

  it("binds one stop artifact of each allowed type to the exact runtime and sender", () => {
    const { capability, binding } = fixture();

    for (const rawType of ["snapshot", "localStorageSnapshot", "screenshot"] as const) {
      expect(
        claimStopDrainEvent(capability, { ...binding, rawType, reason: "stop" })
      ).not.toBeNull();
      expect(claimStopDrainEvent(capability, { ...binding, rawType, reason: "stop" })).toBeNull();
    }
  });

  it("rejects the wrong token, runtime, fence, sid, tab, frame, URL, reason, and type", () => {
    const variants = [
      { token: "wrong" },
      { runtime: {} },
      { fence: { blocked: true } },
      { sid: "S-wrong" },
      { tabId: 43 },
      { frameId: 1 },
      { documentUrl: "https://app.example.test/other" },
      { reason: "interval" },
      { rawType: "indexedDbSnapshot" }
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
