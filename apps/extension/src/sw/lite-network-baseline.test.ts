import { describe, expect, it } from "vitest";

import {
  buildLiteNetworkFailureRawEvent,
  buildLiteNetworkRequestRawEvent,
  buildLiteNetworkResponseRawEvent
} from "./lite-network-baseline.js";

const TEST_CONTEXT = {
  sid: "S-lite-network",
  tabId: 7,
  frame: "content-frame-2"
};

describe("lite-network-baseline", () => {
  it("builds minimal browser-side request events for lite mode", () => {
    const rawEvent = buildLiteNetworkRequestRawEvent(TEST_CONTEXT, {
      requestId: "123",
      method: "post",
      url: "https://example.com/api/items/123?token=secret#frag",
      timeStamp: 101
    });

    expect(rawEvent).toMatchObject({
      source: "content",
      rawType: "fetch",
      sid: "S-lite-network",
      tabId: 7,
      frame: "content-frame-2",
      t: 101,
      mono: 101,
      payload: {
        phase: "start",
        reqId: "123",
        requestId: "123",
        method: "POST",
        url: "https://example.com/api/items/:id"
      }
    });
    expect(rawEvent.payload).not.toHaveProperty("headers");
    expect(rawEvent.payload).not.toHaveProperty("postDataSize");
  });

  it("builds minimal browser-side response events for lite mode", () => {
    const rawEvent = buildLiteNetworkResponseRawEvent(TEST_CONTEXT, {
      requestId: "123",
      method: "get",
      url: "https://example.com/api/items",
      timeStamp: 205,
      statusCode: 204,
      statusLine: "HTTP/1.1 204 No Content",
      duration: 104
    });

    expect(rawEvent).toMatchObject({
      rawType: "fetch",
      payload: {
        phase: "end",
        reqId: "123",
        requestId: "123",
        method: "GET",
        url: "https://example.com/api/items",
        status: 204,
        statusText: "No Content",
        duration: 104,
        ok: true
      }
    });
    expect(rawEvent.payload).not.toHaveProperty("headers");
    expect(rawEvent.payload).not.toHaveProperty("encodedDataLength");
  });

  it("builds minimal browser-side failure events for lite mode", () => {
    const rawEvent = buildLiteNetworkFailureRawEvent(TEST_CONTEXT, {
      requestId: "123",
      method: "get",
      url: "https://example.com/api/items",
      timeStamp: 215,
      duration: 114,
      error: "net::ERR_ABORTED"
    });

    expect(rawEvent).toMatchObject({
      rawType: "fetchError",
      payload: {
        reqId: "123",
        requestId: "123",
        method: "GET",
        url: "https://example.com/api/items",
        duration: 114,
        message: "net::ERR_ABORTED",
        errorText: "net::ERR_ABORTED"
      }
    });
  });
});
