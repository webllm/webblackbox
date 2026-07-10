import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type CapturePolicy
} from "@webblackbox/protocol";

import { WebBlackboxRecorder } from "./recorder.js";
import { WEBSOCKET_FRAME_PAYLOAD_PREVIEW_MAX_CHARS } from "./websocket-frame.js";

type NetworkCapturePolicy = CapturePolicy["categories"]["network"];

type RecordedWebSocketFrame = {
  requestId?: string;
  timestamp?: number;
  direction?: "sent" | "received";
  response?: unknown;
  payloadData?: unknown;
  payloadPreview?: unknown;
  frame?: {
    opcode?: number;
    masked?: boolean;
    payloadLength?: number;
    payloadPreview?: string;
  };
};

describe("WebSocket frame capture policy", () => {
  it.each(["metadata", "headers-allowlist"] as const)(
    "persists metadata without a payload preview in %s mode",
    (networkPolicy) => {
      const rawPayload = "opaque-private-websocket-value";
      const event = ingestWebSocketFrame(networkPolicy, rawPayload);
      const data = event?.data as RecordedWebSocketFrame | undefined;

      expect(event?.type).toBe("network.ws.frame");
      expect(data).toEqual({
        requestId: "ws-request-1",
        timestamp: 12.5,
        direction: "received",
        frame: {
          opcode: 1,
          masked: false,
          payloadLength: rawPayload.length
        }
      });
      expect(JSON.stringify(data)).not.toContain(rawPayload);
      expect(data?.response).toBeUndefined();
      expect(data?.payloadData).toBeUndefined();
      expect(data?.payloadPreview).toBeUndefined();
      expect(data?.frame?.payloadPreview).toBeUndefined();
    }
  );

  it("bounds and redacts payload previews in body-allowlist mode", () => {
    const rawPayload = "x".repeat(WEBSOCKET_FRAME_PAYLOAD_PREVIEW_MAX_CHARS + 80);
    const boundedEvent = ingestWebSocketFrame(
      "body-allowlist",
      rawPayload,
      "Network.webSocketFrameSent"
    );
    const boundedData = boundedEvent?.data as RecordedWebSocketFrame | undefined;

    expect(boundedEvent?.type).toBe("network.ws.frame");
    expect(boundedData?.direction).toBe("sent");
    expect(boundedData?.frame?.payloadLength).toBe(rawPayload.length);
    expect(boundedData?.frame?.payloadPreview).toBe(
      rawPayload.slice(0, WEBSOCKET_FRAME_PAYLOAD_PREVIEW_MAX_CHARS)
    );
    expect(boundedData?.frame?.payloadPreview).toHaveLength(
      WEBSOCKET_FRAME_PAYLOAD_PREVIEW_MAX_CHARS
    );
    expect(boundedData?.response).toBeUndefined();

    const sensitivePayload = "websocket-secret-material";
    const redactedEvent = ingestWebSocketFrame("body-allowlist", sensitivePayload);
    const redactedData = redactedEvent?.data as RecordedWebSocketFrame | undefined;

    expect(redactedData?.frame?.payloadLength).toBe(sensitivePayload.length);
    expect(redactedData?.frame?.payloadPreview).not.toBe(sensitivePayload);
    expect(redactedData?.frame?.payloadPreview).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(redactedData)).not.toContain(sensitivePayload);
  });
});

function ingestWebSocketFrame(
  networkPolicy: NetworkCapturePolicy,
  payloadData: string,
  rawType = "Network.webSocketFrameReceived"
) {
  const recorder = new WebBlackboxRecorder({
    ...DEFAULT_RECORDER_CONFIG,
    capturePolicy: {
      ...DEFAULT_CAPTURE_POLICY,
      categories: {
        ...DEFAULT_CAPTURE_POLICY.categories,
        network: networkPolicy
      }
    }
  });

  return recorder.ingest({
    source: "cdp",
    rawType,
    tabId: 7,
    sid: "S-websocket-policy",
    t: 100,
    mono: 50,
    payload: {
      requestId: "ws-request-1",
      timestamp: 12.5,
      response: {
        opcode: 1,
        mask: false,
        payloadData
      }
    }
  }).event;
}
