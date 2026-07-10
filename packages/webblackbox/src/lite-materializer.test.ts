import { describe, expect, it, vi } from "vitest";

import { DEFAULT_RECORDER_CONFIG, type RecorderConfig } from "@webblackbox/protocol";
import type { RawRecorderEvent } from "@webblackbox/recorder";

import { materializeLiteRawEvent, shouldMaterializeLiteRawEvent } from "./lite-materializer.js";

function createRawEvent(rawType: string, payload: Record<string, unknown>): RawRecorderEvent {
  return {
    source: "content",
    rawType,
    tabId: 7,
    sid: "S-test",
    t: 1,
    mono: 1,
    payload
  };
}

function cloneConfig(): RecorderConfig {
  return {
    ...DEFAULT_RECORDER_CONFIG,
    sampling: {
      ...DEFAULT_RECORDER_CONFIG.sampling
    },
    redaction: {
      ...DEFAULT_RECORDER_CONFIG.redaction,
      redactHeaders: [...DEFAULT_RECORDER_CONFIG.redaction.redactHeaders],
      redactCookieNames: [...DEFAULT_RECORDER_CONFIG.redaction.redactCookieNames],
      redactBodyPatterns: [...DEFAULT_RECORDER_CONFIG.redaction.redactBodyPatterns],
      blockedSelectors: [...DEFAULT_RECORDER_CONFIG.redaction.blockedSelectors]
    },
    sitePolicies: [...DEFAULT_RECORDER_CONFIG.sitePolicies]
  };
}

function enableNetworkBodyCapture(config: RecorderConfig): void {
  config.capturePolicy = {
    ...config.capturePolicy!,
    categories: {
      ...config.capturePolicy!.categories,
      network: "body-allowlist"
    }
  };
}

describe("lite-materializer", () => {
  it("detects which raw events need lite materialization", () => {
    expect(
      shouldMaterializeLiteRawEvent(
        createRawEvent("screenshot", {
          dataUrl: "data:image/png;base64,AA=="
        })
      )
    ).toBe(true);

    expect(
      shouldMaterializeLiteRawEvent(
        createRawEvent("networkBody", {
          reqId: "R-1",
          body: "ok"
        })
      )
    ).toBe(true);

    expect(
      shouldMaterializeLiteRawEvent({
        ...createRawEvent("screenshot", {
          dataUrl: "data:image/png;base64,AA=="
        }),
        source: "cdp"
      })
    ).toBe(false);

    expect(
      shouldMaterializeLiteRawEvent(
        createRawEvent("networkBody", {
          reqId: "R-1"
        })
      )
    ).toBe(false);
  });

  it("materializes screenshot data-url payloads into blob references", async () => {
    const putBlobCalls: Array<{ mime: string; bytes: Uint8Array }> = [];
    const config = cloneConfig();
    config.capturePolicy = {
      ...config.capturePolicy!,
      categories: {
        ...config.capturePolicy!.categories,
        screenshots: "allow"
      }
    };

    const rawEvent = createRawEvent("screenshot", {
      dataUrl: `data:image/png;base64,${Buffer.from([1, 2, 3, 4]).toString("base64")}`,
      w: 640,
      h: 360,
      reason: "start"
    });

    const result = await materializeLiteRawEvent(rawEvent, {
      config,
      putBlob: async (mime, bytes) => {
        putBlobCalls.push({ mime, bytes });
        return "hash-shot";
      }
    });

    expect(putBlobCalls).toHaveLength(1);
    expect(putBlobCalls[0]?.mime).toBe("image/png");
    expect(putBlobCalls[0]?.bytes.byteLength).toBe(4);
    expect(result?.payload).toMatchObject({
      shotId: "hash-shot",
      format: "png",
      w: 640,
      h: 360,
      reason: "start",
      size: 4
    });
  });

  it("does not persist screenshot bytes for masked policy", async () => {
    const config = cloneConfig();
    config.capturePolicy = {
      ...config.capturePolicy!,
      categories: {
        ...config.capturePolicy!.categories,
        screenshots: "masked"
      }
    };
    const putBlob = vi.fn(async () => "unexpected-hash");

    const result = await materializeLiteRawEvent(
      createRawEvent("screenshot", {
        dataUrl: `data:image/png;base64,${Buffer.from([1, 2, 3, 4]).toString("base64")}`
      }),
      {
        config,
        putBlob
      }
    );

    expect(result).toBeNull();
    expect(putBlob).not.toHaveBeenCalled();
  });

  it("materializes network bodies with redaction and byte caps", async () => {
    const config = cloneConfig();
    enableNetworkBodyCapture(config);
    config.sampling.bodyCaptureMaxBytes = 4 * 1024;

    const putBlobCalls: Array<{ mime: string; text: string; bytes: Uint8Array }> = [];
    const body = `token=secret-token&mode=lite&chunk=${"x".repeat(6000)}`;

    const rawEvent = createRawEvent("networkBody", {
      reqId: "R-2",
      url: "https://example.test/api/login",
      mimeType: "application/x-www-form-urlencoded",
      encoding: "utf8",
      body,
      size: new TextEncoder().encode(body).byteLength
    });

    const result = await materializeLiteRawEvent(rawEvent, {
      config,
      putBlob: async (mime, bytes) => {
        putBlobCalls.push({
          mime,
          text: new TextDecoder().decode(bytes),
          bytes
        });
        return "hash-body";
      }
    });

    expect(result).not.toBeNull();
    expect(putBlobCalls).toHaveLength(1);
    expect(putBlobCalls[0]?.mime).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(putBlobCalls[0]?.text).get("token")).toBe("[REDACTED]");
    expect(putBlobCalls[0]?.text).not.toContain("secret-token");
    expect(putBlobCalls[0]?.bytes.byteLength).toBeLessThanOrEqual(4 * 1024);
    expect(putBlobCalls[0]?.bytes.byteLength).toBeLessThan(
      new TextEncoder().encode(body).byteLength
    );
    expect(result?.payload).toMatchObject({
      reqId: "R-2",
      requestId: "R-2",
      contentHash: "hash-body",
      redacted: true,
      truncated: true
    });
  });

  it("decodes base64 JSON and redacts nested sensitive values before persistence", async () => {
    const config = cloneConfig();
    enableNetworkBodyCapture(config);
    config.sampling.bodyCaptureMaxBytes = 64 * 1024;
    const putBlobCalls: Array<{ mime: string; text: string }> = [];
    const body = JSON.stringify({
      user: {
        password: "密碼-不可保留",
        details: [{ api_key: "api-secret-value" }]
      },
      locale: "zh-CN"
    });

    const result = await materializeLiteRawEvent(
      createRawEvent("networkBody", {
        reqId: "R-base64-json",
        url: "https://example.test/api/profile",
        mimeType: "application/json; charset=utf-8",
        encoding: "base64",
        body: Buffer.from(body, "utf8").toString("base64"),
        size: new TextEncoder().encode(body).byteLength
      }),
      {
        config,
        putBlob: async (mime, bytes) => {
          putBlobCalls.push({ mime, text: new TextDecoder().decode(bytes) });
          return "hash-base64-json";
        }
      }
    );

    expect(result).not.toBeNull();
    expect(putBlobCalls).toHaveLength(1);
    expect(putBlobCalls[0]?.mime).toBe("application/json");

    const persisted = JSON.parse(putBlobCalls[0]?.text ?? "") as {
      user: { password: string; details: Array<{ api_key: string }> };
      locale: string;
    };

    expect(persisted.user.password).toBe("[REDACTED]");
    expect(persisted.user.details[0]?.api_key).toBe("[REDACTED]");
    expect(persisted.locale).toBe("zh-CN");
    expect(putBlobCalls[0]?.text).not.toContain("不可保留");
    expect(putBlobCalls[0]?.text).not.toContain("api-secret-value");
    expect(result?.payload).toMatchObject({
      contentHash: "hash-base64-json",
      redacted: true,
      truncated: false
    });
  });

  it("does not persist malformed structured or undecodable textual bodies", async () => {
    const config = cloneConfig();
    enableNetworkBodyCapture(config);
    config.sampling.bodyCaptureMaxBytes = 64 * 1024;
    const putBlob = vi.fn(async () => "unexpected-hash");
    const context = { config, putBlob };

    const malformedJson = await materializeLiteRawEvent(
      createRawEvent("networkBody", {
        reqId: "R-malformed-json",
        url: "https://example.test/api/profile",
        mimeType: "application/json",
        encoding: "utf8",
        body: '{"password":"unterminated}'
      }),
      context
    );
    const invalidUtf8 = await materializeLiteRawEvent(
      createRawEvent("networkBody", {
        reqId: "R-invalid-utf8",
        url: "https://example.test/api/profile",
        mimeType: "application/json",
        encoding: "base64",
        body: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64")
      }),
      context
    );

    expect(malformedJson).toBeNull();
    expect(invalidUtf8).toBeNull();
    expect(putBlob).not.toHaveBeenCalled();
  });

  it("does not persist network bodies without an allowed MIME type", async () => {
    const config = cloneConfig();
    enableNetworkBodyCapture(config);
    config.sampling.bodyCaptureMaxBytes = 4 * 1024;
    const putBlob = vi.fn(async () => "unexpected-hash");

    const result = await materializeLiteRawEvent(
      createRawEvent("networkBody", {
        reqId: "R-missing-mime",
        url: "https://example.test/api/binary",
        encoding: "base64",
        body: Buffer.from([0, 1, 2, 3]).toString("base64"),
        size: 4
      }),
      {
        config,
        putBlob
      }
    );

    expect(result).toBeNull();
    expect(putBlob).not.toHaveBeenCalled();
  });

  it("respects site policy deny rules for body capture", async () => {
    const config = cloneConfig();
    enableNetworkBodyCapture(config);
    config.sitePolicies = [
      {
        originPattern: "https://example.test",
        mode: "lite",
        enabled: true,
        allowBodyCapture: false,
        bodyMimeAllowlist: [],
        pathAllowlist: [],
        pathDenylist: []
      }
    ];

    const result = await materializeLiteRawEvent(
      createRawEvent("networkBody", {
        reqId: "R-3",
        url: "https://example.test/api/private",
        mimeType: "application/json",
        encoding: "utf8",
        body: '{"token":"abc"}',
        size: 15
      }),
      {
        config,
        putBlob: async () => "unused"
      }
    );

    expect(result).toBeNull();
  });

  it("drops forged network bodies before persistence outside body-allowlist policy", async () => {
    for (const networkPolicy of ["metadata", "headers-allowlist", undefined] as const) {
      const config = cloneConfig();
      config.sampling.bodyCaptureMaxBytes = 4 * 1024;
      if (networkPolicy === undefined) {
        delete config.capturePolicy;
      } else {
        config.capturePolicy = {
          ...config.capturePolicy!,
          categories: {
            ...config.capturePolicy!.categories,
            network: networkPolicy
          }
        };
      }
      const putBlob = vi.fn(async () => "unexpected-hash");

      const result = await materializeLiteRawEvent(
        createRawEvent("networkBody", {
          reqId: `R-forged-${networkPolicy ?? "missing"}`,
          url: "https://example.test/api/private",
          mimeType: "application/json",
          encoding: "utf8",
          body: '{"secret":"must-not-be-persisted"}'
        }),
        { config, putBlob }
      );

      expect(result).toBeNull();
      expect(putBlob).not.toHaveBeenCalled();
    }
  });

  it("drops localStorage entry samples during materialization", async () => {
    const putBlob = vi.fn(async () => "unused");

    const result = await materializeLiteRawEvent(
      createRawEvent("localStorageSnapshot", {
        count: 1,
        entries: {
          token: {
            length: 19,
            sample: "storage-secret-token"
          }
        }
      }),
      {
        config: cloneConfig(),
        putBlob
      }
    );

    expect(putBlob).not.toHaveBeenCalled();
    expect(result?.payload).toMatchObject({
      count: 1,
      mode: "schema-only",
      redacted: true
    });
    expect(result?.payload).not.toHaveProperty("hash");
    expect(JSON.stringify(result)).not.toContain("storage-secret-token");
  });

  it("drops cookie and IndexedDB names during materialization", async () => {
    const putBlob = vi.fn(async () => "unused");
    const context = {
      config: cloneConfig(),
      putBlob
    };

    const cookieResult = await materializeLiteRawEvent(
      createRawEvent("cookieSnapshot", {
        names: ["sessionSecret", "tenant-cookie"],
        count: 2
      }),
      context
    );
    const idbResult = await materializeLiteRawEvent(
      createRawEvent("indexedDbSnapshot", {
        databaseNames: ["customer-secret-db"],
        count: 1
      }),
      context
    );

    expect(putBlob).not.toHaveBeenCalled();
    expect(cookieResult?.payload).toMatchObject({
      count: 2,
      mode: "schema-only",
      redacted: true
    });
    expect(idbResult?.payload).toMatchObject({
      count: 1,
      mode: "schema-only",
      redacted: true
    });
    expect(JSON.stringify(cookieResult)).not.toContain("sessionSecret");
    expect(JSON.stringify(idbResult)).not.toContain("customer-secret-db");
  });

  it("treats a zero body-capture budget as disabled", async () => {
    const config = cloneConfig();
    enableNetworkBodyCapture(config);
    config.sampling.bodyCaptureMaxBytes = 0;

    const result = await materializeLiteRawEvent(
      createRawEvent("networkBody", {
        reqId: "R-4",
        url: "https://example.test/api/private",
        mimeType: "application/json",
        encoding: "utf8",
        body: '{"token":"abc"}',
        size: 15
      }),
      {
        config,
        putBlob: async () => "unused"
      }
    );

    expect(result).toBeNull();
  });
});
