import { describe, expect, it } from "vitest";

import { normalizeShareServerBaseUrl, resolveShareArchiveRequest } from "./share.js";

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

  it.each([
    "http://share.example.test/share/abcdefgh",
    "ftp://share.example.test/share/abcdefgh",
    "file:///share/abcdefgh",
    "https://user:secret@share.example.test/share/abcdefgh"
  ])("rejects an unsafe share reference %s", (reference) => {
    expect(resolveShareArchiveRequest(reference, "https://fallback.invalid")).toBeNull();
  });

  it("rejects an id when its fallback server is unsafe", () => {
    expect(resolveShareArchiveRequest("abcdefgh", "http://share.example.test")).toBeNull();
  });

  it("rejects query credentials that cannot be sent as safe headers", () => {
    expect(
      resolveShareArchiveRequest(
        "https://share.example.test/share/abcdefgh?key=line%0Abreak",
        "https://fallback.invalid"
      )
    ).toBeNull();
  });
});

describe("normalizeShareServerBaseUrl", () => {
  it.each([
    ["https://share.example.test/path?ignored=true", "https://share.example.test"],
    ["http://localhost:8787", "http://localhost:8787"],
    ["http://127.42.0.9:8787", "http://127.42.0.9:8787"],
    ["http://[::1]:8787", "http://[::1]:8787"]
  ])("normalizes a safe server URL %s", (input, expected) => {
    expect(normalizeShareServerBaseUrl(input)).toBe(expected);
  });

  it.each([
    "http://share.example.test",
    "ws://localhost:8787",
    "javascript:alert(1)",
    "https://user:secret@share.example.test"
  ])("rejects an unsafe server URL %s", (input) => {
    expect(normalizeShareServerBaseUrl(input)).toBeNull();
  });
});
