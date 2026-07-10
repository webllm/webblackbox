import { describe, expect, it } from "vitest";

import { parseShareApiCredentials } from "./auth-config.js";

describe("share API credential configuration", () => {
  it("parses explicit least-privilege scopes", () => {
    const credentials = parseShareApiCredentials(
      "upload-key:upload;reader-key:read,list;ops-key:revoke",
      null
    );

    expect(credentials.map(({ secret, scopes }) => [secret, [...scopes]])).toEqual([
      ["upload-key", ["upload"]],
      ["reader-key", ["read", "list"]],
      ["ops-key", ["revoke"]]
    ]);
  });

  it("preserves explicit legacy admin keys without a scope suffix", () => {
    const credentials = parseShareApiCredentials("legacy-admin", "legacy-env-admin");

    expect(credentials.map(({ secret, scopes }) => [secret, [...scopes]])).toEqual([
      ["legacy-env-admin", ["admin"]],
      ["legacy-admin", ["admin"]]
    ]);
  });

  it.each([
    ["unknown scope", "key:uplod", "unknown scope 'uplod'"],
    ["empty scope", "key:", "must declare at least one scope"],
    ["mixed valid and invalid scopes", "key:read,typo", "unknown scope 'typo'"],
    ["empty scope in a list", "key:read,", "unknown scope '(empty)'"],
    ["empty secret", ":read", "secret cannot be empty"]
  ])("rejects %s", (_label, value, expectedMessage) => {
    expect(() => parseShareApiCredentials(value, null)).toThrow(expectedMessage);
  });

  it("rejects duplicate secrets across legacy and scoped configuration", () => {
    expect(() => parseShareApiCredentials("duplicate:read", "duplicate")).toThrow(
      /secrets must be unique/i
    );
  });

  it("rejects a non-empty credential list containing only separators", () => {
    expect(() => parseShareApiCredentials(";;;", null)).toThrow(/at least one credential/i);
  });
});
