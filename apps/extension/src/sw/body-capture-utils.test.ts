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
      body: `token=secret-123&message=${"界".repeat(5_000)}`,
      base64Encoded: false,
      mimeType: "application/x-www-form-urlencoded; charset=utf-8",
      redactPatterns: ["secret-123"],
      maxBytes: 4_096,
      decodeBase64: decodeBase64ForTest
    });

    expect(transformed).not.toBeNull();

    if (!transformed) {
      throw new Error("Expected response body transformation to succeed");
    }

    const sampledText = new TextDecoder().decode(transformed.sampledBytes);

    expect(transformed.redacted).toBe(true);
    expect(transformed.truncated).toBe(true);
    expect(sampledText).toContain("%5BREDACTED%5D");
    expect(transformed.sampledBytes.byteLength).toBe(4_096);
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(transformed.sampledBytes)
    ).not.toThrow();
    expect(transformed.originalBytes.byteLength).toBeGreaterThan(
      transformed.sampledBytes.byteLength
    );
  });

  it("decodes and redacts textual base64 response bodies", () => {
    const body = JSON.stringify({ profile: { password: "plain-secret" }, status: "ok" });
    const transformed = transformResponseBodyForCapture({
      body: Buffer.from(body, "utf8").toString("base64"),
      base64Encoded: true,
      mimeType: "application/json",
      redactPatterns: ["password", "secret"],
      maxBytes: 64 * 1024,
      decodeBase64: decodeBase64ForTest
    });

    expect(transformed).not.toBeNull();

    if (!transformed) {
      throw new Error("Expected response body transformation to succeed");
    }

    const sampled = JSON.parse(new TextDecoder().decode(transformed.sampledBytes)) as {
      profile: { password: string };
      status: string;
    };

    expect(transformed.redacted).toBe(true);
    expect(transformed.truncated).toBe(false);
    expect(sampled).toEqual({ profile: { password: "[REDACTED]" }, status: "ok" });
    expect(JSON.stringify(sampled)).not.toContain("plain-secret");
  });

  it("redacts nested JSON field values including UTF-8 secrets", () => {
    const body = JSON.stringify({
      account: {
        password: "密碼-不可保留",
        nested: [{ apiKey: "key-123" }]
      },
      displayName: "使用者"
    });
    const transformed = transformResponseBodyForCapture({
      body,
      base64Encoded: false,
      mimeType: "application/problem+json",
      redactPatterns: ["password", "apikey"],
      maxBytes: 64 * 1024,
      decodeBase64: decodeBase64ForTest
    });

    expect(transformed).not.toBeNull();

    if (!transformed) {
      throw new Error("Expected response body transformation to succeed");
    }

    const sampled = JSON.parse(new TextDecoder().decode(transformed.sampledBytes)) as {
      account: { password: string; nested: Array<{ apiKey: string }> };
      displayName: string;
    };

    expect(sampled.account.password).toBe("[REDACTED]");
    expect(sampled.account.nested[0]?.apiKey).toBe("[REDACTED]");
    expect(sampled.displayName).toBe("使用者");
    expect(new TextDecoder().decode(transformed.sampledBytes)).not.toContain("不可保留");
    expect(new TextDecoder().decode(transformed.sampledBytes)).not.toContain("key-123");
  });

  it("redacts sensitive form field values while retaining safe fields", () => {
    const transformed = transformResponseBodyForCapture({
      body: "username=alice&password=hunter2&refresh_token=token-value&locale=zh-CN",
      base64Encoded: false,
      mimeType: "application/x-www-form-urlencoded",
      redactPatterns: ["password", "token"],
      maxBytes: 64 * 1024,
      decodeBase64: decodeBase64ForTest
    });

    expect(transformed).not.toBeNull();

    if (!transformed) {
      throw new Error("Expected response body transformation to succeed");
    }

    const sampled = new URLSearchParams(new TextDecoder().decode(transformed.sampledBytes));

    expect(sampled.get("username")).toBe("alice");
    expect(sampled.get("password")).toBe("[REDACTED]");
    expect(sampled.get("refresh_token")).toBe("[REDACTED]");
    expect(sampled.get("locale")).toBe("zh-CN");
  });

  it("fails closed when structured response parsing fails", () => {
    expect(
      transformResponseBodyForCapture({
        body: '{"password":"unterminated}',
        base64Encoded: false,
        mimeType: "application/json",
        redactPatterns: ["password"],
        maxBytes: 64 * 1024,
        decodeBase64: decodeBase64ForTest
      })
    ).toBeNull();

    expect(
      transformResponseBodyForCapture({
        body: "password=%E0%A4%A",
        base64Encoded: false,
        mimeType: "application/x-www-form-urlencoded",
        redactPatterns: ["password"],
        maxBytes: 64 * 1024,
        decodeBase64: decodeBase64ForTest
      })
    ).toBeNull();
  });

  it("fails closed for invalid UTF-8 base64 and non-text MIME bodies", () => {
    expect(
      transformResponseBodyForCapture({
        body: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64"),
        base64Encoded: true,
        mimeType: "application/json",
        redactPatterns: ["password"],
        maxBytes: 64 * 1024,
        decodeBase64: decodeBase64ForTest
      })
    ).toBeNull();

    expect(
      transformResponseBodyForCapture({
        body: Buffer.from("plain-secret", "utf8").toString("base64"),
        base64Encoded: true,
        mimeType: "application/octet-stream",
        redactPatterns: ["secret"],
        maxBytes: 64 * 1024,
        decodeBase64: decodeBase64ForTest
      })
    ).toBeNull();
  });

  it("fails closed for unstructured text when sensitive patterns require field redaction", () => {
    expect(
      transformResponseBodyForCapture({
        body: "password: hunter2",
        base64Encoded: false,
        mimeType: "text/plain",
        redactPatterns: ["password"],
        maxBytes: 64 * 1024,
        decodeBase64: decodeBase64ForTest
      })
    ).toBeNull();
  });
});
