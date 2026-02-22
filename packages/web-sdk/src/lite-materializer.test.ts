import { describe, expect, it } from "vitest";

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

    const rawEvent = createRawEvent("screenshot", {
      dataUrl: `data:image/png;base64,${Buffer.from([1, 2, 3, 4]).toString("base64")}`,
      w: 640,
      h: 360,
      reason: "start"
    });

    const result = await materializeLiteRawEvent(rawEvent, {
      config: cloneConfig(),
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

  it("materializes network bodies with redaction and byte caps", async () => {
    const config = cloneConfig();
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
    expect(putBlobCalls[0]?.text).toContain("[REDACTED]");
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

  it("respects site policy deny rules for body capture", async () => {
    const config = cloneConfig();
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
});
