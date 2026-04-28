import { describe, expect, it } from "vitest";

import {
  REQUEST_META_MAX_ENTRIES,
  REQUEST_META_TTL_MS,
  buildRequestMetaKey,
  getRequestMeta,
  upsertRequestMeta
} from "./request-meta.js";

describe("request-meta", () => {
  it("keys CDP child sessions separately from root requests", () => {
    expect(buildRequestMetaKey("req-1")).toBe("req-1");
    expect(buildRequestMetaKey("req-1", "child-a")).toBe("cdp:child-a:req-1");
    expect(buildRequestMetaKey("req-1", "child-b")).toBe("cdp:child-b:req-1");
  });

  it("expires stale request metadata", () => {
    const entries = new Map();

    upsertRequestMeta(entries, "req-1", { url: "https://example.test/a" }, 1_000);

    expect(getRequestMeta(entries, "req-1", 1_000 + REQUEST_META_TTL_MS)).toMatchObject({
      url: "https://example.test/a"
    });
    expect(getRequestMeta(entries, "req-1", 1_001 + REQUEST_META_TTL_MS)).toBeUndefined();
    expect(entries.size).toBe(0);
  });

  it("trims oldest metadata beyond the bounded capacity", () => {
    const entries = new Map();

    for (let index = 0; index < REQUEST_META_MAX_ENTRIES + 3; index += 1) {
      upsertRequestMeta(entries, `req-${index}`, { url: `https://example.test/${index}` }, index);
    }

    expect(entries.size).toBe(REQUEST_META_MAX_ENTRIES);
    expect(entries.has("req-0")).toBe(false);
    expect(entries.has("req-1")).toBe(false);
    expect(entries.has("req-2")).toBe(false);
    expect(entries.has(`req-${REQUEST_META_MAX_ENTRIES + 2}`)).toBe(true);
  });
});
