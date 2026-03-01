import { describe, expect, it } from "vitest";

import type { RecorderConfig, WebBlackboxEvent, WebBlackboxEventType } from "@webblackbox/protocol";

import { FreezePolicy } from "./freeze.js";

const BASE_CONFIG: RecorderConfig = {
  mode: "lite",
  ringBufferMinutes: 5,
  freezeOnError: true,
  freezeOnNetworkFailure: true,
  freezeOnLongTaskSpike: true,
  sampling: {
    mousemoveHz: 20,
    scrollHz: 15,
    domFlushMs: 100,
    screenshotIdleMs: 8000,
    snapshotIntervalMs: 20000,
    actionWindowMs: 1500,
    bodyCaptureMaxBytes: 262144
  },
  redaction: {
    redactHeaders: ["authorization", "cookie", "set-cookie"],
    redactCookieNames: ["token", "session", "auth"],
    redactBodyPatterns: ["password", "token", "secret", "otp"],
    blockedSelectors: [".secret", "[data-sensitive]", "input[type='password']"],
    hashSensitiveValues: true
  },
  sitePolicies: []
};

function createEvent(
  type: WebBlackboxEventType,
  t: number,
  data: Record<string, unknown> = {}
): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-freeze-test",
    tab: 1,
    t,
    mono: t,
    type,
    id: `E-${t}-${type}`,
    data
  };
}

function createPolicy(overrides: Partial<RecorderConfig> = {}): FreezePolicy {
  return new FreezePolicy({
    ...BASE_CONFIG,
    ...overrides
  });
}

describe("FreezePolicy", () => {
  it("returns error freeze for runtime exception events when enabled", () => {
    const policy = createPolicy();
    const reason = policy.evaluate(createEvent("error.exception", 1));

    expect(reason).toBe("error");
  });

  it("does not freeze for errors when freezeOnError is disabled", () => {
    const policy = createPolicy({
      freezeOnError: false
    });
    const reason = policy.evaluate(createEvent("error.unhandledrejection", 1));

    expect(reason).toBeNull();
  });

  it("returns network freeze after 3 network failures inside 10s window", () => {
    const policy = createPolicy();
    expect(policy.evaluate(createEvent("network.failed", 1_000))).toBeNull();
    expect(policy.evaluate(createEvent("network.failed", 5_000))).toBeNull();
    expect(policy.evaluate(createEvent("network.failed", 9_999))).toBe("network");
  });

  it("drops stale network failure timestamps outside the freeze window", () => {
    const policy = createPolicy();
    expect(policy.evaluate(createEvent("network.failed", 1_000))).toBeNull();
    expect(policy.evaluate(createEvent("network.failed", 5_000))).toBeNull();
    expect(policy.evaluate(createEvent("network.failed", 12_000))).toBeNull();
  });

  it("returns perf freeze for longtask duration >= 200ms", () => {
    const policy = createPolicy();
    const reason = policy.evaluate(
      createEvent("perf.longtask", 2_000, {
        duration: 200
      })
    );

    expect(reason).toBe("perf");
  });

  it("ignores invalid or short longtask payloads", () => {
    const policy = createPolicy();
    expect(policy.evaluate(createEvent("perf.longtask", 2_000, {}))).toBeNull();
    expect(
      policy.evaluate(
        createEvent("perf.longtask", 2_100, {
          duration: Number.NaN
        })
      )
    ).toBeNull();
    expect(
      policy.evaluate(
        createEvent("perf.longtask", 2_200, {
          duration: 199.9
        })
      )
    ).toBeNull();
  });

  it("always returns marker freeze for marker events", () => {
    const policy = createPolicy({
      freezeOnError: false,
      freezeOnNetworkFailure: false,
      freezeOnLongTaskSpike: false
    });
    const reason = policy.evaluate(createEvent("user.marker", 3_000));

    expect(reason).toBe("marker");
  });
});
