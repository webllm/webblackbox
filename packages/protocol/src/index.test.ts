import { describe, expect, it } from "vitest";

import {
  createSessionId,
  DEFAULT_RECORDER_CONFIG,
  EventIdFactory,
  eventEnvelopeSchema,
  extractRequestId,
  extractRequestIdFromPayload,
  exportManifestSchema,
  validateEvent,
  validateMessage,
  WEBBLACKBOX_PROTOCOL_VERSION
} from "./index.js";

describe("protocol", () => {
  it("creates deterministic id prefixes", () => {
    const sessionId = createSessionId(1_700_000_000_000);
    const ids = new EventIdFactory();

    expect(sessionId.startsWith("S-1700000000000-")).toBe(true);
    expect(ids.next()).toBe("E-00000001");
    expect(ids.next()).toBe("E-00000002");
  });

  it("validates an event envelope", () => {
    const result = validateEvent({
      v: WEBBLACKBOX_PROTOCOL_VERSION,
      sid: "S-1",
      tab: 1,
      t: Date.now(),
      mono: 42,
      type: "network.request",
      id: "E-1",
      data: {
        reqId: "R-1",
        url: "https://example.com/api",
        method: "GET"
      }
    });

    expect(result.success).toBe(true);
  });

  it("validates control messages", () => {
    const result = validateMessage({
      t: "CTRL.START_SESSION",
      sid: "S-1",
      tabId: 3,
      mode: "lite",
      config: DEFAULT_RECORDER_CONFIG
    });

    expect(result.success).toBe(true);
  });

  it("parses export manifest schema", () => {
    const result = exportManifestSchema.safeParse({
      protocolVersion: 1,
      createdAt: "2026-02-13T00:00:00.000Z",
      mode: "full",
      site: {
        origin: "https://example.com",
        title: "Example"
      },
      chunkCodec: "none",
      redactionProfile: DEFAULT_RECORDER_CONFIG.redaction,
      stats: {
        eventCount: 120,
        chunkCount: 3,
        blobCount: 8,
        durationMs: 9000
      }
    });

    expect(result.success).toBe(true);
  });

  it("exposes event envelope schema", () => {
    const parsed = eventEnvelopeSchema.safeParse({
      v: WEBBLACKBOX_PROTOCOL_VERSION,
      sid: "S-2",
      tab: 9,
      t: Date.now(),
      mono: 12.5,
      type: "user.marker",
      id: "E-2",
      data: { message: "bug" }
    });

    expect(parsed.success).toBe(true);
  });

  it("extracts request ids from payloads and event refs", () => {
    expect(extractRequestIdFromPayload({ reqId: "R-1" })).toBe("R-1");
    expect(extractRequestIdFromPayload({ requestId: "R-2" })).toBe("R-2");
    expect(extractRequestIdFromPayload({ request: { requestId: "R-3" } })).toBe("R-3");
    expect(
      extractRequestId({
        ref: { req: "R-ref" },
        data: { requestId: "R-payload" }
      })
    ).toBe("R-ref");
  });
});
