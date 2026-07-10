import { describe, expect, it, vi } from "vitest";

import { createDeploymentMarker, waitForSiteDeployment } from "./pages-deployment.mjs";

const expectedCommit = "a".repeat(40);

describe("Pages deployment verification", () => {
  it("creates a deterministic marker bound to the source commit", () => {
    expect(createDeploymentMarker(expectedCommit, "v1.2.3")).toEqual({
      schemaVersion: 1,
      commit: expectedCommit,
      tag: "v1.2.3"
    });
  });

  it("waits until the deployed marker matches instead of accepting stale HTML", async () => {
    let markerRequests = 0;
    const fetchImplementation = vi.fn(async (url) => {
      if (new URL(url).pathname.endsWith("deployment.json")) {
        markerRequests += 1;
        return Response.json({
          schemaVersion: 1,
          commit: markerRequests === 1 ? "b".repeat(40) : expectedCommit,
          tag: "v1.2.3"
        });
      }
      return new Response("<title>WebBlackbox Player</title>");
    });

    await waitForSiteDeployment({
      siteUrl: "https://example.test/webblackbox/",
      expectedCommit,
      timeoutMs: 100,
      pollIntervalMs: 0,
      fetchImplementation
    });

    expect(markerRequests).toBe(2);
  });

  it("fails when the site never serves the expected commit", async () => {
    const fetchImplementation = vi.fn(async (url) => {
      if (new URL(url).pathname.endsWith("deployment.json")) {
        return Response.json({ commit: "b".repeat(40) });
      }
      return new Response("<title>WebBlackbox Player</title>");
    });

    await expect(
      waitForSiteDeployment({
        siteUrl: "https://example.test/webblackbox/",
        expectedCommit,
        timeoutMs: 10,
        pollIntervalMs: 0,
        fetchImplementation
      })
    ).rejects.toThrow(`serve commit ${expectedCommit}`);
  });
});
