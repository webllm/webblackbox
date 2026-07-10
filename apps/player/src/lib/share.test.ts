import { describe, expect, it } from "vitest";

import { resolveShareArchiveRequest } from "./share.js";

describe("resolveShareArchiveRequest", () => {
  it("resolves a share id against the configured server", () => {
    expect(resolveShareArchiveRequest("abcdefgh", "https://share.example.test")).toEqual({
      shareId: "abcdefgh",
      baseUrl: "https://share.example.test",
      archiveUrl: "https://share.example.test/api/share/abcdefgh/archive"
    });
  });

  it.each([
    "https://share.example.test/share/abcdefgh?key=query-secret",
    "https://share.example.test/api/share/abcdefgh/meta?key=query-secret",
    "https://share.example.test/api/share/abcdefgh/archive?key=query-secret"
  ])("moves a query key from %s into an API header credential", (reference) => {
    const resolved = resolveShareArchiveRequest(reference, "https://fallback.invalid");

    expect(resolved).toEqual({
      shareId: "abcdefgh",
      baseUrl: "https://share.example.test",
      archiveUrl: "https://share.example.test/api/share/abcdefgh/archive",
      queryApiKey: "query-secret"
    });
    expect(resolved?.archiveUrl).not.toContain("key=");
  });

  it("does not propagate unrelated query parameters or fragments", () => {
    const resolved = resolveShareArchiveRequest(
      "https://share.example.test/share/abcdefgh?utm_source=test#secret-fragment",
      "https://fallback.invalid"
    );

    expect(resolved?.archiveUrl).toBe("https://share.example.test/api/share/abcdefgh/archive");
    expect(resolved).not.toHaveProperty("queryApiKey");
  });

  it("rejects unsupported references", () => {
    expect(
      resolveShareArchiveRequest("https://share.example.test/other/path", "https://fallback")
    ).toBeNull();
  });
});
