import { describe, expect, it } from "vitest";

import { createReplayHeaders, shouldAttachReplayBody } from "./replay.js";

describe("createReplayHeaders", () => {
  it("drops forbidden and redacted headers", () => {
    const headers = createReplayHeaders({
      Authorization: "Bearer token",
      "Content-Length": "120",
      Cookie: "sid=abc",
      "sec-ch-ua": '"Chromium";v="131"',
      "X-Custom": "ok",
      "X-Trace": "[REDACTED]"
    });

    expect(headers.get("authorization")).toBe("Bearer token");
    expect(headers.get("x-custom")).toBe("ok");
    expect(headers.get("content-length")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("sec-ch-ua")).toBeNull();
    expect(headers.get("x-trace")).toBeNull();
  });
});

describe("shouldAttachReplayBody", () => {
  it("does not attach body for GET/HEAD", () => {
    expect(shouldAttachReplayBody("GET", "{}")).toBe(false);
    expect(shouldAttachReplayBody("HEAD", "payload")).toBe(false);
  });

  it("attaches body for other methods when provided", () => {
    expect(shouldAttachReplayBody("POST", "{}")).toBe(true);
    expect(shouldAttachReplayBody("PUT", "payload")).toBe(true);
    expect(shouldAttachReplayBody("PATCH", undefined)).toBe(false);
  });
});
