import { describe, expect, it } from "vitest";

import { hasPassedSharePrivacyPreflight } from "./share-privacy.js";

describe("hasPassedSharePrivacyPreflight", () => {
  it("accepts only an explicitly passed pre-encryption scan", () => {
    expect(hasPassedSharePrivacyPreflight({ preEncryption: true, status: "passed" })).toBe(true);
    expect(hasPassedSharePrivacyPreflight({ preEncryption: false, status: "passed" })).toBe(false);
    expect(hasPassedSharePrivacyPreflight({ preEncryption: true, status: "blocked" })).toBe(false);
    expect(hasPassedSharePrivacyPreflight({ preEncryption: true, status: "unknown" })).toBe(false);
    expect(hasPassedSharePrivacyPreflight(undefined)).toBe(false);
  });
});
