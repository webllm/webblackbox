import { describe, expect, it, vi } from "vitest";

import { consumeAutoShareLocation, resolveAutoShareLocation } from "./auto-share-location.js";

const FRAGMENT_REFERENCE = "https://fragment.example.test/share/abcdefgh?key=fragment-secret";
const QUERY_REFERENCE = "https://query.example.test/share/ijklmnop?key=query-secret";

describe("auto share location", () => {
  it("prefers the fragment reference and preserves unrelated query and fragment parameters", () => {
    const href =
      `https://player.example.test/view?lang=zh-CN&share=${encodeURIComponent(QUERY_REFERENCE)}` +
      `#panel=network&share=${encodeURIComponent(FRAGMENT_REFERENCE)}&event=E-1`;
    const resolved = resolveAutoShareLocation(href);

    expect(resolved.reference).toBe(FRAGMENT_REFERENCE);
    expect(resolved.source).toBe("fragment");
    expect(resolved.cleanedUrl).toBe(
      "https://player.example.test/view?lang=zh-CN#panel=network&event=E-1"
    );
  });

  it("does not retain a nested query credential from the consumed fragment", () => {
    const href =
      `https://player.example.test/?theme=dark#share=${encodeURIComponent(FRAGMENT_REFERENCE)}` +
      "&panel=details";
    const resolved = resolveAutoShareLocation(href);

    expect(resolved.reference).toBe(FRAGMENT_REFERENCE);
    expect(resolved.cleanedUrl).toBe("https://player.example.test/?theme=dark#panel=details");
    expect(resolved.cleanedUrl).not.toContain("key=");
    expect(resolved.cleanedUrl).not.toContain("fragment-secret");
  });

  it("scrubs a legacy query reference while preserving other query and hash parameters", () => {
    const href =
      `https://player.example.test/view?lang=en&share=${encodeURIComponent(QUERY_REFERENCE)}` +
      "#panel=timeline";
    const resolved = resolveAutoShareLocation(href);

    expect(resolved).toEqual({
      reference: QUERY_REFERENCE,
      source: "query",
      cleanedUrl: "https://player.example.test/view?lang=en#panel=timeline"
    });
    expect(resolved.cleanedUrl).not.toContain("key=");
    expect(resolved.cleanedUrl).not.toContain("query-secret");
  });

  it("does not mutate history when no non-empty share reference exists", () => {
    const replaceState = vi.fn();

    expect(
      consumeAutoShareLocation("https://player.example.test/?lang=en#panel=timeline", replaceState)
    ).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("replaces history synchronously before the caller starts loading", async () => {
    const order: string[] = [];
    const href = `https://player.example.test/?share=${encodeURIComponent(QUERY_REFERENCE)}`;
    const reference = consumeAutoShareLocation(href, (cleanedUrl) => {
      order.push("history");
      expect(cleanedUrl).toBe("https://player.example.test/");
    });

    await Promise.resolve().then(() => {
      order.push("load");
    });

    expect(reference).toBe(QUERY_REFERENCE);
    expect(order).toEqual(["history", "load"]);
  });
});
