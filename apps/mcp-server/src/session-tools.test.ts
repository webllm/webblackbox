import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import type { ExportManifest, WebBlackboxEvent } from "@webblackbox/protocol";

import {
  compareSessions,
  exportHarFromArchive,
  findRootCauseCandidates,
  generateBugReportBundle,
  generatePlaywrightFromArchive,
  listArchives,
  summarizeActions
} from "./session-tools.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, {
        recursive: true,
        force: true
      })
    )
  );
});

describe("session tools", () => {
  it("lists archive files and ignores non-archive files", async () => {
    const root = await mkdtemp(join(tmpdir(), "wb-mcp-list-"));
    tempDirs.push(root);

    await writeFile(join(root, "a.webblackbox"), "alpha");
    await writeFile(join(root, "b.zip"), "bravo");
    await writeFile(join(root, "ignore.txt"), "ignore");

    const result = await listArchives({
      dir: root,
      recursive: false,
      limit: 10
    });

    expect(result.count).toBe(2);
    expect(result.archives.map((row) => row.path)).toEqual(
      expect.arrayContaining([join(root, "a.webblackbox"), join(root, "b.zip")])
    );
  });

  it("supports recursive scan and result limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "wb-mcp-recursive-"));
    tempDirs.push(root);

    await mkdir(join(root, "nested"), {
      recursive: true
    });
    await writeFile(join(root, "base.webblackbox"), "base");
    await writeFile(join(root, "nested", "child.webblackbox"), "child");

    const shallow = await listArchives({
      dir: root,
      recursive: false,
      limit: 10
    });
    expect(shallow.count).toBe(1);

    const recursive = await listArchives({
      dir: root,
      recursive: true,
      limit: 1
    });
    expect(recursive.count).toBe(1);
  });

  it("applies archive limits after sorting by modification time", async () => {
    const root = await mkdtemp(join(tmpdir(), "wb-mcp-list-limit-"));
    tempDirs.push(root);

    const older = join(root, "a-older.webblackbox");
    const newer = join(root, "z-newer.webblackbox");
    await writeFile(older, "older");
    await writeFile(newer, "newer");
    await utimes(older, new Date("2024-01-01T00:00:00.000Z"), new Date("2024-01-01T00:00:00.000Z"));
    await utimes(newer, new Date("2025-01-01T00:00:00.000Z"), new Date("2025-01-01T00:00:00.000Z"));

    const result = await listArchives({
      dir: root,
      recursive: false,
      limit: 1
    });

    expect(result.archives.map((row) => row.path)).toEqual([newer]);
  });

  it("summarizes actions from a real archive fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "wb-mcp-positive-actions-"));
    tempDirs.push(root);

    const archivePath = join(root, "regression.webblackbox");
    const archiveBytes = await createArchiveFixture(createRegressionEvents());
    await writeFile(archivePath, Buffer.from(archiveBytes));

    const result = await summarizeActions({
      path: archivePath,
      limit: 10
    });
    const action = result.actions.find((entry) => entry.actId === "A-2");

    expect(result.totals.actions).toBeGreaterThan(0);
    expect(action).toBeDefined();
    expect(action?.triggerType).toBe("user.click");
    expect(action?.requestCount).toBe(1);
    expect(action?.errorCount).toBe(1);
    expect(action?.requests[0]).toEqual(
      expect.objectContaining({
        reqId: "REQ-R-1",
        method: "GET",
        status: 500
      })
    );
    expect(action?.screenshot).toEqual(
      expect.objectContaining({
        shotId: "SHOT-R-1",
        format: "webp"
      })
    );
  });

  it("finds root-cause candidates with nearby network and console context", async () => {
    const root = await mkdtemp(join(tmpdir(), "wb-mcp-positive-root-cause-"));
    tempDirs.push(root);

    const archivePath = join(root, "regression.webblackbox");
    const archiveBytes = await createArchiveFixture(createRegressionEvents());
    await writeFile(archivePath, Buffer.from(archiveBytes));

    const result = await findRootCauseCandidates({
      path: archivePath,
      limit: 5,
      windowMs: 10_000
    });
    const candidate = result.candidates.find((entry) => entry.eventId === "E-R-6");

    expect(candidate).toBeDefined();
    expect(candidate?.type).toBe("error.exception");
    expect(candidate?.nearbyNetwork).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reqId: "REQ-R-1",
          status: 500,
          failed: false
        })
      ])
    );
    expect(candidate?.nearbyConsole).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error"
        })
      ])
    );
  });

  it("returns endpoint regressions when comparing real archive fixtures", async () => {
    const root = await mkdtemp(join(tmpdir(), "wb-mcp-positive-compare-"));
    tempDirs.push(root);

    const leftPath = join(root, "baseline.webblackbox");
    const rightPath = join(root, "regression.webblackbox");
    await writeFile(leftPath, Buffer.from(await createArchiveFixture(createBaselineEvents())));
    await writeFile(rightPath, Buffer.from(await createArchiveFixture(createRegressionEvents())));

    const result = await compareSessions({
      leftPath,
      rightPath,
      topRequestDiffs: 10
    });

    expect(result.summary.errorDelta).toBeGreaterThan(0);
    expect(result.errorDiff.fingerprintRegressions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fingerprint: "error.exception:Checkout failed",
          leftCount: 0,
          rightCount: 1,
          delta: 1
        })
      ])
    );
    expect(result.networkDiff.endpointRegressions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint: "https://example.com/api/items",
          method: "GET",
          leftFailed: 0,
          rightFailed: 1,
          failedDelta: 1
        })
      ])
    );
    expect(result.actionDiff.triggerRegressions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          triggerType: "user.click",
          delta: 1
        })
      ])
    );
    expect(result.perfDiff.longtask).toEqual(
      expect.objectContaining({
        leftCount: 1,
        rightCount: 2,
        delta: 1
      })
    );
    expect(result.perfDiff.vitalRegressions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "lcp"
        })
      ])
    );
  });

  it("throws helpful errors when report archive is missing", async () => {
    const missing = join(tmpdir(), `wb-mcp-missing-${Date.now()}.webblackbox`);

    await expect(
      generateBugReportBundle({
        path: missing
      })
    ).rejects.toThrowError("Failed to open archive");
  });

  it("throws helpful errors when compare archive is missing", async () => {
    const missingLeft = join(tmpdir(), `wb-mcp-missing-left-${Date.now()}.webblackbox`);
    const missingRight = join(tmpdir(), `wb-mcp-missing-right-${Date.now()}.webblackbox`);

    await expect(
      compareSessions({
        leftPath: missingLeft,
        rightPath: missingRight
      })
    ).rejects.toThrowError("Failed to open archive");
  });

  it("throws helpful errors when exporting HAR for missing archive", async () => {
    const missing = join(tmpdir(), `wb-mcp-missing-har-${Date.now()}.webblackbox`);

    await expect(
      exportHarFromArchive({
        path: missing
      })
    ).rejects.toThrowError("Failed to open archive");
  });

  it("throws helpful errors when generating Playwright script for missing archive", async () => {
    const missing = join(tmpdir(), `wb-mcp-missing-playwright-${Date.now()}.webblackbox`);

    await expect(
      generatePlaywrightFromArchive({
        path: missing
      })
    ).rejects.toThrowError("Failed to open archive");
  });

  it("throws helpful errors when summarizing actions for missing archive", async () => {
    const missing = join(tmpdir(), `wb-mcp-missing-actions-${Date.now()}.webblackbox`);

    await expect(
      summarizeActions({
        path: missing
      })
    ).rejects.toThrowError("Failed to open archive");
  });

  it("throws helpful errors when finding root-cause candidates for missing archive", async () => {
    const missing = join(tmpdir(), `wb-mcp-missing-root-cause-${Date.now()}.webblackbox`);

    await expect(
      findRootCauseCandidates({
        path: missing
      })
    ).rejects.toThrowError("Failed to open archive");
  });
});

async function createArchiveFixture(events: WebBlackboxEvent[]): Promise<Uint8Array> {
  const zip = new JSZip();
  const firstEvent = events[0];
  const lastEvent = events[events.length - 1];
  const durationMs =
    typeof firstEvent?.mono === "number" && typeof lastEvent?.mono === "number"
      ? Math.max(0, Number((lastEvent.mono - firstEvent.mono).toFixed(2)))
      : 0;
  const reqIndexMap = new Map<string, string[]>();

  for (const event of events) {
    const reqId = event.ref?.req;

    if (!reqId) {
      continue;
    }

    const ids = reqIndexMap.get(reqId) ?? [];
    ids.push(event.id);
    reqIndexMap.set(reqId, ids);
  }

  const reqIndex = [...reqIndexMap.entries()].map(([reqId, eventIds]) => ({
    reqId,
    eventIds
  }));
  const manifest: ExportManifest = {
    protocolVersion: 1,
    createdAt: new Date(0).toISOString(),
    mode: "full",
    site: {
      origin: "https://example.com",
      title: "MCP Positive Fixture"
    },
    chunkCodec: "none",
    redactionProfile: {
      redactHeaders: [],
      redactCookieNames: [],
      redactBodyPatterns: [],
      blockedSelectors: [],
      hashSensitiveValues: true
    },
    stats: {
      eventCount: events.length,
      chunkCount: 1,
      blobCount: 0,
      durationMs
    }
  };

  const files = new Map<string, string>();
  const addJsonFile = (path: string, value: unknown) => {
    const content = JSON.stringify(value, null, 2);
    zip.file(path, content);
    files.set(path, content);
  };
  const addTextFile = (path: string, content: string) => {
    zip.file(path, content);
    files.set(path, content);
  };

  addJsonFile("manifest.json", manifest);
  addJsonFile("index/time.json", []);
  addJsonFile("index/req.json", reqIndex);
  addJsonFile("index/inv.json", []);
  addTextFile(
    "events/chunk-000001.ndjson",
    events.map((event) => JSON.stringify(event)).join("\n")
  );

  const fileHashes = Object.fromEntries(
    [...files.entries()].map(([path, content]) => [path, sha256Hex(content)])
  );

  addJsonFile("integrity/hashes.json", {
    manifestSha256: fileHashes["manifest.json"] ?? "",
    files: fileHashes
  });

  return zip.generateAsync({ type: "uint8array" });
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(Buffer.from(content)).digest("hex");
}

function createBaselineEvents(): WebBlackboxEvent[] {
  return [
    {
      v: 1,
      sid: "S-B-1",
      tab: 1,
      t: 1_000,
      mono: 1,
      type: "meta.session.start",
      id: "E-B-1",
      data: {}
    },
    {
      v: 1,
      sid: "S-B-1",
      tab: 1,
      t: 1_001,
      mono: 2,
      type: "user.click",
      id: "E-B-2",
      ref: {
        act: "A-1"
      },
      data: {
        target: {
          selector: "button.checkout"
        }
      }
    },
    {
      v: 1,
      sid: "S-B-1",
      tab: 1,
      t: 1_002,
      mono: 3,
      type: "network.request",
      id: "E-B-3",
      ref: {
        act: "A-1",
        req: "REQ-B-1"
      },
      data: {
        requestId: "REQ-B-1",
        request: {
          method: "GET",
          url: "https://example.com/api/items"
        }
      }
    },
    {
      v: 1,
      sid: "S-B-1",
      tab: 1,
      t: 1_003,
      mono: 4,
      type: "network.response",
      id: "E-B-4",
      ref: {
        act: "A-1",
        req: "REQ-B-1"
      },
      data: {
        requestId: "REQ-B-1",
        response: {
          status: 200,
          statusText: "OK",
          mimeType: "application/json"
        }
      }
    },
    {
      v: 1,
      sid: "S-B-1",
      tab: 1,
      t: 1_004,
      mono: 5,
      type: "perf.longtask",
      id: "E-B-5",
      ref: {
        act: "A-1"
      },
      data: {
        name: "baseline-longtask",
        startTime: 4.2,
        duration: 80
      }
    },
    {
      v: 1,
      sid: "S-B-1",
      tab: 1,
      t: 1_005,
      mono: 5.5,
      type: "perf.vitals",
      id: "E-B-6",
      ref: {
        act: "A-1"
      },
      data: {
        metric: "largest-contentful-paint",
        value: 1_800
      }
    }
  ];
}

function createRegressionEvents(): WebBlackboxEvent[] {
  return [
    {
      v: 1,
      sid: "S-R-1",
      tab: 1,
      t: 2_000,
      mono: 10,
      type: "meta.session.start",
      id: "E-R-1",
      data: {}
    },
    {
      v: 1,
      sid: "S-R-1",
      tab: 1,
      t: 2_001,
      mono: 11,
      type: "user.click",
      id: "E-R-2",
      ref: {
        act: "A-2"
      },
      data: {
        target: {
          selector: "button.checkout"
        }
      }
    },
    {
      v: 1,
      sid: "S-R-1",
      tab: 1,
      t: 2_002,
      mono: 12,
      type: "network.request",
      id: "E-R-3",
      ref: {
        act: "A-2",
        req: "REQ-R-1"
      },
      data: {
        requestId: "REQ-R-1",
        request: {
          method: "GET",
          url: "https://example.com/api/items"
        }
      }
    },
    {
      v: 1,
      sid: "S-R-1",
      tab: 1,
      t: 2_003,
      mono: 16,
      type: "console.entry",
      id: "E-R-4",
      ref: {
        act: "A-2"
      },
      data: {
        level: "error",
        text: "HTTP 500 from /api/items"
      }
    },
    {
      v: 1,
      sid: "S-R-1",
      tab: 1,
      t: 2_004,
      mono: 18,
      type: "network.response",
      id: "E-R-5",
      ref: {
        act: "A-2",
        req: "REQ-R-1"
      },
      data: {
        requestId: "REQ-R-1",
        response: {
          status: 500,
          statusText: "Internal Server Error",
          mimeType: "application/json"
        }
      }
    },
    {
      v: 1,
      sid: "S-R-1",
      tab: 1,
      t: 2_005,
      mono: 19,
      type: "error.exception",
      id: "E-R-6",
      lvl: "error",
      ref: {
        act: "A-2"
      },
      data: {
        message: "Checkout failed",
        aiRootCause: {
          summary: "Backend returned HTTP 500"
        }
      }
    },
    {
      v: 1,
      sid: "S-R-1",
      tab: 1,
      t: 2_006,
      mono: 19.2,
      type: "screen.screenshot",
      id: "E-R-7",
      ref: {
        act: "A-2"
      },
      data: {
        shotId: "SHOT-R-1",
        reason: "action",
        format: "webp",
        size: 256
      }
    },
    {
      v: 1,
      sid: "S-R-1",
      tab: 1,
      t: 2_007,
      mono: 20,
      type: "user.click",
      id: "E-R-8",
      ref: {
        act: "A-3"
      },
      data: {
        target: {
          selector: "button.retry"
        }
      }
    },
    {
      v: 1,
      sid: "S-R-1",
      tab: 1,
      t: 2_008,
      mono: 21,
      type: "perf.longtask",
      id: "E-R-9",
      ref: {
        act: "A-3"
      },
      data: {
        name: "regression-longtask-a",
        startTime: 20.1,
        duration: 120
      }
    },
    {
      v: 1,
      sid: "S-R-1",
      tab: 1,
      t: 2_009,
      mono: 22,
      type: "perf.longtask",
      id: "E-R-10",
      ref: {
        act: "A-3"
      },
      data: {
        name: "regression-longtask-b",
        startTime: 21.4,
        duration: 180
      }
    },
    {
      v: 1,
      sid: "S-R-1",
      tab: 1,
      t: 2_010,
      mono: 23,
      type: "perf.vitals",
      id: "E-R-11",
      ref: {
        act: "A-3"
      },
      data: {
        metric: "largest-contentful-paint",
        value: 3_200
      }
    }
  ];
}
