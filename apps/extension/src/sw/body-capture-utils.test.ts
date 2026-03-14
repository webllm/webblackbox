import { describe, expect, it } from "vitest";

import {
  resolveFullBodyCaptureRule,
  resolveLiteBodyCaptureRule,
  transformResponseBodyForCapture
} from "./body-capture-utils.js";

function decodeBase64ForTest(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

describe("body-capture utils", () => {
  it("disables full-mode body capture when matching policy denies body capture", () => {
    const rule = resolveFullBodyCaptureRule(
      {
        sampling: {
          bodyCaptureMaxBytes: 64 * 1024
        },
        sitePolicies: [
          {
            originPattern: "https://api.example.com",
            mode: "full",
            enabled: true,
            allowBodyCapture: false,
            bodyMimeAllowlist: [],
            pathAllowlist: [],
            pathDenylist: []
          }
        ]
      },
      "https://api.example.com/v1/search",
      "application/json"
    );

    expect(rule.enabled).toBe(false);
  });

  it("disables full-mode body capture when policy mime allowlist excludes response mime", () => {
    const rule = resolveFullBodyCaptureRule(
      {
        sampling: {
          bodyCaptureMaxBytes: 64 * 1024
        },
        sitePolicies: [
          {
            originPattern: "https://api.example.com",
            mode: "full",
            enabled: true,
            allowBodyCapture: true,
            bodyMimeAllowlist: ["application/json"],
            pathAllowlist: [],
            pathDenylist: []
          }
        ]
      },
      "https://api.example.com/v1/search",
      "text/html"
    );

    expect(rule.enabled).toBe(false);
    expect(rule.mimeAllowlist).toEqual(["application/json"]);
  });

  it("keeps lite-mode default capture rule enabled for unmatched policies", () => {
    const rule = resolveLiteBodyCaptureRule(
      {
        sampling: {
          bodyCaptureMaxBytes: 64 * 1024
        },
        sitePolicies: []
      },
      "https://example.com/page",
      "image/png"
    );

    expect(rule.enabled).toBe(true);
  });

  it("treats zero bodyCaptureMaxBytes as disabled", () => {
    const rule = resolveLiteBodyCaptureRule(
      {
        sampling: {
          bodyCaptureMaxBytes: 0
        },
        sitePolicies: []
      },
      "https://example.com/page",
      "application/json"
    );

    expect(rule.enabled).toBe(false);
    expect(rule.maxBytes).toBe(0);
  });

  it("redacts and truncates utf8 response bodies for capture", () => {
    const transformed = transformResponseBodyForCapture({
      body: `token=secret-123&${"x".repeat(5_000)}`,
      base64Encoded: false,
      redactPatterns: ["secret-123"],
      maxBytes: 4_096,
      decodeBase64: decodeBase64ForTest
    });

    const sampledText = new TextDecoder().decode(transformed.sampledBytes);

    expect(transformed.redacted).toBe(true);
    expect(transformed.truncated).toBe(true);
    expect(sampledText).toContain("[REDACTED]");
    expect(transformed.sampledBytes.byteLength).toBe(4_096);
    expect(transformed.originalBytes.byteLength).toBeGreaterThan(
      transformed.sampledBytes.byteLength
    );
  });

  it("does not redact base64 response bodies", () => {
    const transformed = transformResponseBodyForCapture({
      body: Buffer.from("plain-secret", "utf8").toString("base64"),
      base64Encoded: true,
      redactPatterns: ["secret"],
      maxBytes: 64 * 1024,
      decodeBase64: decodeBase64ForTest
    });

    const sampledText = new TextDecoder().decode(transformed.sampledBytes);

    expect(transformed.redacted).toBe(false);
    expect(transformed.truncated).toBe(false);
    expect(sampledText).toBe("plain-secret");
  });
});
