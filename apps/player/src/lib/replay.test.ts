import { describe, expect, it } from "vitest";

import {
  createReplayHeaders,
  isReplayResourceAllowedByDefault,
  shouldAttachReplayBody
} from "./replay.js";

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

describe("isReplayResourceAllowedByDefault", () => {
  it("allows only inert local replay resources", () => {
    expect(isReplayResourceAllowedByDefault("blob:http://localhost/shot")).toBe(true);
    expect(isReplayResourceAllowedByDefault("data:image/png;base64,AAAA")).toBe(true);
    expect(isReplayResourceAllowedByDefault("https://cdn.example.test/shot.png")).toBe(false);
    expect(isReplayResourceAllowedByDefault("javascript:alert(1)")).toBe(false);
    expect(isReplayResourceAllowedByDefault("data:text/html;base64,PHNjcmlwdA==")).toBe(false);
  });
});
