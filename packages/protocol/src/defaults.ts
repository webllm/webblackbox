import type { RecorderConfig } from "./types.js";

export const DEFAULT_RECORDER_CONFIG: RecorderConfig = {
  mode: "lite",
  ringBufferMinutes: 10,
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
