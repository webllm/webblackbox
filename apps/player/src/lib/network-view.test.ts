import { describe, expect, it } from "vitest";

import type { NetworkWaterfallEntry } from "@webblackbox/player-sdk";

import {
  applyNetworkViewFilters,
  resolveNetworkStatusClass,
  resolveNetworkTypeBucket,
  sortNetworkEntries
} from "./network-view.js";

function entry(overrides: Partial<NetworkWaterfallEntry>): NetworkWaterfallEntry {
  return {
    reqId: overrides.reqId ?? "R-1",
    url: overrides.url ?? "https://example.com/api/items",
    method: overrides.method ?? "GET",
    status: overrides.status,
    statusText: overrides.statusText,
    mimeType: overrides.mimeType,
    startMono: overrides.startMono ?? 0,
    endMono: overrides.endMono ?? 10,
    durationMs: overrides.durationMs ?? 10,
    startWallTime: overrides.startWallTime ?? 0,
    endWallTime: overrides.endWallTime ?? 10,
    failed: overrides.failed ?? false,
    errorText: overrides.errorText,
    actionId: overrides.actionId,
    encodedDataLength: overrides.encodedDataLength,
    requestHeaders: overrides.requestHeaders ?? {},
    responseHeaders: overrides.responseHeaders ?? {},
    requestBodyText: overrides.requestBodyText,
    responseBodyHash: overrides.responseBodyHash,
    responseBodySize: overrides.responseBodySize,
    eventIds: overrides.eventIds ?? []
  };
}

describe("applyNetworkViewFilters", () => {
  const rows: NetworkWaterfallEntry[] = [
    entry({
      reqId: "R-200",
      url: "https://example.com/api/items",
      method: "GET",
      status: 200,
      mimeType: "application/json"
    }),
    entry({
      reqId: "R-404",
      url: "https://example.com/static/logo.png",
      method: "GET",
      status: 404,
      mimeType: "image/png"
    }),
    entry({
      reqId: "R-failed",
      url: "https://example.com/api/pay",
      method: "POST",
      failed: true,
      mimeType: "application/json"
    })
  ];

  it("filters by method/status/type/query", () => {
    const filtered = applyNetworkViewFilters(rows, {
      query: "pay",
      method: "POST",
      status: "failed",
      type: "fetch"
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.reqId).toBe("R-failed");
  });

  it("keeps successful fetch requests under success status filter", () => {
    const filtered = applyNetworkViewFilters(rows, {
      query: "",
      method: "all",
      status: "success",
      type: "fetch"
    });

    expect(filtered.map((item) => item.reqId)).toEqual(["R-200"]);
  });
});

describe("sortNetworkEntries", () => {
  it("preserves stable order on equal compare keys", () => {
    const rows = [
      entry({ reqId: "R-1", durationMs: 40, startMono: 1 }),
      entry({ reqId: "R-2", durationMs: 40, startMono: 2 })
    ];

    const sorted = sortNetworkEntries(rows, "time", "asc");
    expect(sorted.map((item) => item.reqId)).toEqual(["R-1", "R-2"]);
  });
});

describe("network classifiers", () => {
  it("maps MIME types and status classes", () => {
    expect(resolveNetworkTypeBucket("application/json")).toBe("fetch");
    expect(resolveNetworkTypeBucket("text/css")).toBe("stylesheet");
    expect(resolveNetworkTypeBucket("font/woff2")).toBe("font");

    expect(resolveNetworkStatusClass(entry({ status: 204 }))).toBe("wf-status-ok");
    expect(resolveNetworkStatusClass(entry({ status: 302 }))).toBe("wf-status-redirect");
    expect(resolveNetworkStatusClass(entry({ status: 500 }))).toBe("wf-status-error");
    expect(resolveNetworkStatusClass(entry({ failed: true }))).toBe("wf-status-failed");
  });
});
