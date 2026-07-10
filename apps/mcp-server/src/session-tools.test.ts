import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import type { ExportManifest, WebBlackboxEvent } from "@webblackbox/protocol";

import {
  MAX_MCP_PATH_CHARS,
  MCP_ARCHIVE_SCAN_LIMITS,
  MCP_HAR_EXPORT_LIMITS,
  assertArchiveScanBudget,
  compareSessions,
  exportHarFromArchive,
  findRootCauseCandidates,
  generateBugReportBundle,
  generatePlaywrightFromArchive,
  listArchives,
  sessionSummaryInput,
  summarizeActions
} from "./session-tools.js";
import { MAX_MCP_TEXT_PAYLOAD_BYTES } from "./output-limits.js";

const tempDirs: string[] = [];

type HarLimitFailure = Error & { actual: number };

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
  it("rejects oversized paths and bounded-scan exhaustion", async () => {
    expect(sessionSummaryInput.path.safeParse("x".repeat(MAX_MCP_PATH_CHARS + 1)).success).toBe(
      false
    );
    await expect(
      listArchives({
        dir: "x".repeat(MAX_MCP_PATH_CHARS + 1),
        recursive: false
      })
    ).rejects.toThrow(/path exceeds the MCP limit/i);

    expect(() =>
      assertArchiveScanBudget(Date.now(), MCP_ARCHIVE_SCAN_LIMITS.entries + 1, 1)
    ).toThrow(/entry limit/i);
    expect(() =>
      assertArchiveScanBudget(Date.now(), 1, MCP_ARCHIVE_SCAN_LIMITS.directories + 1)
    ).toThrow(/directory limit/i);
  });

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

  it("rejects oversized archives from stat metadata before reading them", async () => {
    const root = await mkdtemp(join(tmpdir(), "wb-mcp-oversized-"));
    tempDirs.push(root);
    const archivePath = join(root, "oversized.webblackbox");

    await writeFile(archivePath, "");
    await truncate(archivePath, 64 * 1024 * 1024 + 1);

    await expect(
      summarizeActions({
        path: archivePath,
        limit: 1
      })
    ).rejects.toThrow(/archive input exceeds the MCP limit/i);
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

  it("rejects HAR request counts after observing only maxEntries plus one", async () => {
    const root = await mkdtemp(join(tmpdir(), "wb-mcp-har-entry-limit-"));
    tempDirs.push(root);
    const archivePath = join(root, "many-requests.webblackbox");
    const fixture = createHarFixture(
      Array.from({ length: MCP_HAR_EXPORT_LIMITS.maxEntries + 1 }, () => 0)
    );
    const archiveBytes = await createArchiveFixture(fixture.events, {
      blobs: fixture.blobs,
      compression: "DEFLATE"
    });
    await writeFile(archivePath, archiveBytes);

    const error = await rejectedError(exportHarFromArchive({ path: archivePath }));

    expect(error).toMatchObject({
      name: "HarExportResourceLimitError",
      resource: "maxEntries",
      limit: MCP_HAR_EXPORT_LIMITS.maxEntries,
      actual: MCP_HAR_EXPORT_LIMITS.maxEntries + 1,
      completedEntries: 0,
      bodyBytesRead: 0
    });
  });

  it("stops inflating a single compressed HAR body at its byte budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "wb-mcp-har-body-limit-"));
    tempDirs.push(root);
    const archivePath = join(root, "large-body.webblackbox");
    const fullBodyBytes = MCP_HAR_EXPORT_LIMITS.maxBodyBytes + 512 * 1024;
    const fixture = createHarFixture([fullBodyBytes]);
    const archiveBytes = await createArchiveFixture(fixture.events, {
      blobs: fixture.blobs,
      compression: "DEFLATE"
    });
    expect(archiveBytes.byteLength).toBeLessThan(fullBodyBytes / 20);
    await writeFile(archivePath, archiveBytes);

    const error = await rejectedError(exportHarFromArchive({ path: archivePath }));

    expect(error).toMatchObject({
      name: "HarExportResourceLimitError",
      resource: "maxBodyBytes",
      limit: MCP_HAR_EXPORT_LIMITS.maxBodyBytes,
      completedEntries: 0,
      bodyBytesRead: MCP_HAR_EXPORT_LIMITS.maxBodyBytes
    });
    expect((error as HarLimitFailure).actual).toBeGreaterThan(MCP_HAR_EXPORT_LIMITS.maxBodyBytes);
    expect((error as HarLimitFailure).actual).toBeLessThan(fullBodyBytes);
  });

  it("stops a multi-body HAR at the cumulative read budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "wb-mcp-har-total-body-limit-"));
    tempDirs.push(root);
    const archivePath = join(root, "many-bodies.webblackbox");
    const bodySizes = [900 * 1024, 900 * 1024, 900 * 1024];
    const fixture = createHarFixture(bodySizes);
    const archiveBytes = await createArchiveFixture(fixture.events, {
      blobs: fixture.blobs,
      compression: "DEFLATE"
    });
    const fullBodyBytes = bodySizes.reduce((total, size) => total + size, 0);
    expect(archiveBytes.byteLength).toBeLessThan(fullBodyBytes / 20);
    await writeFile(archivePath, archiveBytes);

    const error = await rejectedError(exportHarFromArchive({ path: archivePath }));

    expect(error).toMatchObject({
      name: "HarExportResourceLimitError",
      resource: "maxTotalBodyBytes",
      limit: MCP_HAR_EXPORT_LIMITS.maxTotalBodyBytes,
      completedEntries: 2,
      bodyBytesRead: MCP_HAR_EXPORT_LIMITS.maxTotalBodyBytes
    });
    expect((error as HarLimitFailure).actual).toBeGreaterThan(
      MCP_HAR_EXPORT_LIMITS.maxTotalBodyBytes
    );
    expect((error as HarLimitFailure).actual).toBeLessThan(fullBodyBytes);
  });

  it("keeps the final encoded HAR envelope within the MCP text limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "wb-mcp-har-output-limit-"));
    tempDirs.push(root);
    const archivePath = join(root, "bounded-output.webblackbox");
    const fixture = createHarFixture([256 * 1024]);
    const archiveBytes = await createArchiveFixture(fixture.events, {
      blobs: fixture.blobs,
      compression: "DEFLATE"
    });
    await writeFile(archivePath, archiveBytes);

    const result = await exportHarFromArchive({ path: archivePath });
    const serialized = JSON.stringify(result, null, 2);
    const emptyEnvelope = JSON.stringify({ ...result, har: "" }, null, 2);
    const expectedBytes =
      Buffer.byteLength(emptyEnvelope, "utf8") -
      2 +
      Buffer.byteLength(JSON.stringify(result.har), "utf8");

    expect(Buffer.byteLength(serialized, "utf8")).toBe(expectedBytes);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(MAX_MCP_TEXT_PAYLOAD_BYTES);
    expect(JSON.parse(result.har)).toMatchObject({
      log: {
        entries: [expect.any(Object)]
      }
    });
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

async function createArchiveFixture(
  events: WebBlackboxEvent[],
  options: {
    blobs?: Record<string, Uint8Array>;
    compression?: "DEFLATE" | "STORE";
  } = {}
): Promise<Uint8Array> {
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
  const chunkId = "chunk-000001";
  const eventContent = events.map((event) => JSON.stringify(event)).join("\n");
  const eventBytes = Buffer.from(eventContent);
  const timeIndex =
    firstEvent && lastEvent
      ? [
          {
            chunkId,
            seq: 1,
            tStart: firstEvent.t,
            tEnd: lastEvent.t,
            monoStart: firstEvent.mono,
            monoEnd: lastEvent.mono,
            eventCount: events.length,
            byteLength: eventBytes.byteLength,
            codec: "none" as const,
            sha256: sha256Hex(eventContent)
          }
        ]
      : [];
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
      blobCount: Object.keys(options.blobs ?? {}).length,
      durationMs
    }
  };

  const files = new Map<string, Uint8Array>();
  const addJsonFile = (path: string, value: unknown) => {
    const content = Buffer.from(JSON.stringify(value, null, 2));
    zip.file(path, content);
    files.set(path, content);
  };
  const addTextFile = (path: string, content: string) => {
    const bytes = Buffer.from(content);
    zip.file(path, bytes);
    files.set(path, bytes);
  };

  addJsonFile("manifest.json", manifest);
  addJsonFile("index/time.json", timeIndex);
  addJsonFile("index/req.json", reqIndex);
  addJsonFile("index/inv.json", []);
  addTextFile(`events/${chunkId}.ndjson`, eventContent);
  for (const [path, bytes] of Object.entries(options.blobs ?? {})) {
    zip.file(path, bytes);
    files.set(path, bytes);
  }

  const fileHashes = Object.fromEntries(
    [...files.entries()].map(([path, content]) => [path, sha256Hex(content)])
  );

  addJsonFile("integrity/hashes.json", {
    manifestSha256: fileHashes["manifest.json"] ?? "",
    files: fileHashes
  });

  return zip.generateAsync({
    type: "uint8array",
    compression: options.compression ?? "STORE",
    compressionOptions: options.compression === "DEFLATE" ? { level: 9 } : undefined
  });
}

function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(Buffer.from(content)).digest("hex");
}

function createHarFixture(bodySizes: number[]): {
  events: WebBlackboxEvent[];
  blobs: Record<string, Uint8Array>;
} {
  const events: WebBlackboxEvent[] = [
    {
      v: 1,
      sid: "S-HAR",
      tab: 1,
      t: 1_700_000_000_000,
      mono: 0,
      type: "meta.session.start",
      id: "E-HAR-START",
      data: {}
    }
  ];
  const blobs: Record<string, Uint8Array> = {};

  bodySizes.forEach((bodySize, index) => {
    const reqId = `REQ-HAR-${index}`;
    const hash = `har-body-${index}`;
    const mono = index * 10 + 1;
    events.push(
      {
        v: 1,
        sid: "S-HAR",
        tab: 1,
        t: 1_700_000_000_000 + mono,
        mono,
        type: "network.request",
        id: `E-HAR-${index}-REQUEST`,
        ref: { req: reqId },
        data: {
          requestId: reqId,
          request: {
            method: "GET",
            url: `https://example.test/api/${index}`
          }
        }
      },
      {
        v: 1,
        sid: "S-HAR",
        tab: 1,
        t: 1_700_000_000_002 + mono,
        mono: mono + 2,
        type: "network.response",
        id: `E-HAR-${index}-RESPONSE`,
        ref: { req: reqId },
        data: {
          requestId: reqId,
          response: {
            url: `https://example.test/api/${index}`,
            status: 200,
            statusText: "OK",
            mimeType: "application/json"
          }
        }
      }
    );

    if (bodySize > 0) {
      events.push({
        v: 1,
        sid: "S-HAR",
        tab: 1,
        t: 1_700_000_000_003 + mono,
        mono: mono + 3,
        type: "network.body",
        id: `E-HAR-${index}-BODY`,
        ref: { req: reqId },
        data: {
          reqId,
          contentHash: hash,
          size: bodySize
        }
      });
      blobs[`blobs/sha256-${hash}.json`] = new Uint8Array(bodySize).fill(0x78);
    }
  });

  return { events, blobs };
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }

  throw new Error("Expected promise to reject.");
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
          url: "https://example.com/api/items",
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
          url: "https://example.com/api/items",
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
