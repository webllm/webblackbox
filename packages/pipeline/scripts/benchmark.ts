import { performance } from "node:perf_hooks";

import type {
  PrivacyClassification,
  PrivacyDataCategory,
  SessionMetadata,
  WebBlackboxEvent
} from "@webblackbox/protocol";

import {
  FlightRecorderPipeline,
  MemoryPipelineStorage,
  readWebBlackboxArchive
} from "../src/index.js";

const DEFAULT_EVENT_COUNT = 25_000;
const DEFAULT_PAYLOAD_BYTES = 900;
const DEFAULT_MAX_ARCHIVE_MB = 100;
const DEFAULT_RECENT_MINUTES = 20;
const DEFAULT_SCREENSHOT_INTERVAL = 120;
const DEFAULT_BLOB_POOL = 24;
const DEFAULT_BLOB_BYTES = 24 * 1024;
const EVENT_STEP_MS = 120;
const FULL_EXPORT_OPTIONS = {
  includeScreenshots: true,
  maxArchiveBytes: null,
  recentWindowMs: null
} as const;

type PipelineBenchmarkReport = {
  eventCount: number;
  payloadBytes: number;
  screenshotInterval: number;
  maxArchiveMb: number;
  recentMinutes: number;
  ingestDurationMs: number;
  ingestThroughputOpsPerSec: number;
  chunkCount: number;
  uniqueBlobCount: number;
  fullExportDurationMs: number;
  fullParseDurationMs: number;
  fullExportBytes: number;
  fullExportEvents: number;
  filteredExportDurationMs: number;
  filteredParseDurationMs: number;
  filteredExportBytes: number;
  filteredExportEvents: number;
  archiveDropRatio: number;
  eventDropRatio: number;
};

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = Number(raw);

  if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function toMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatMs(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function formatOps(value: number): string {
  return `${Math.round(value).toLocaleString()} ops/s`;
}

function createNoisyPayload(size: number, seed: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789-_";
  let state = ((seed + 1) * 48_271) % 2_147_483_647;
  let output = "";

  for (let index = 0; index < size; index += 1) {
    state = (state * 48_271) % 2_147_483_647;
    const cursor = state % chars.length;
    output += chars[cursor] ?? "x";
  }

  return output;
}

function createBinary(size: number, seed: number): Uint8Array {
  const output = new Uint8Array(size);
  let state = ((seed + 7) * 65_537) % 2_147_483_647;

  for (let index = 0; index < size; index += 1) {
    state = (state * 16_807) % 2_147_483_647;
    output[index] = state & 255;
  }

  return output;
}

async function createBenchmarkPipeline(): Promise<{
  pipeline: FlightRecorderPipeline;
  session: SessionMetadata;
  storage: MemoryPipelineStorage;
}> {
  const storage = new MemoryPipelineStorage();
  const now = Date.now();
  const session: SessionMetadata = {
    sid: `S-pipeline-bench-${now}`,
    tabId: 1,
    startedAt: now - 45 * 60 * 1000,
    mode: "full",
    url: "https://example.test/dashboard",
    title: "Pipeline Benchmark",
    tags: ["benchmark"]
  };
  const pipeline = new FlightRecorderPipeline({
    session,
    storage,
    maxChunkBytes: 512 * 1024,
    chunkCodec: "none"
  });

  await pipeline.start();

  return {
    pipeline,
    session,
    storage
  };
}

function createEvent(
  sessionId: string,
  index: number,
  timestamp: number,
  textPool: string[],
  screenshotHashes: string[],
  screenshotInterval: number,
  blobBytes: number
): WebBlackboxEvent {
  const base: Omit<WebBlackboxEvent, "type" | "id" | "data" | "privacy"> = {
    v: 1,
    sid: sessionId,
    tab: 1,
    t: timestamp,
    mono: index * EVENT_STEP_MS
  };

  if (index % screenshotInterval === 0) {
    const shotId = screenshotHashes[index % screenshotHashes.length] ?? screenshotHashes[0] ?? "";

    return {
      ...base,
      type: "screen.screenshot",
      id: `E-shot-${index}`,
      privacy: createBenchmarkPrivacy("screenshots", true),
      data: {
        shotId,
        format: "webp",
        size: blobBytes
      }
    };
  }

  if (index % 4 === 0) {
    return {
      ...base,
      type: "network.request",
      id: `E-req-${index}`,
      privacy: createBenchmarkPrivacy("network"),
      data: {
        reqId: `R-${Math.floor(index / 2)}`,
        method: "POST",
        url: `https://example.test/api/items/${index % 200}`,
        headers: {
          "content-type": "application/json"
        },
        body: textPool[index % textPool.length] ?? ""
      }
    };
  }

  if (index % 4 === 1) {
    return {
      ...base,
      type: "network.response",
      id: `E-res-${index}`,
      privacy: createBenchmarkPrivacy("network"),
      data: {
        reqId: `R-${Math.floor((index - 1) / 2)}`,
        status: index % 9 === 0 ? 500 : 200,
        duration: 45 + (index % 40),
        bodyHash: textPool[(index + 7) % textPool.length] ?? ""
      }
    };
  }

  if (index % 4 === 2) {
    return {
      ...base,
      type: "console.entry",
      id: `E-log-${index}`,
      privacy: createBenchmarkPrivacy("console"),
      data: {
        level: index % 12 === 0 ? "error" : "log",
        text: textPool[(index + 13) % textPool.length] ?? "",
        source: "benchmark"
      }
    };
  }

  return {
    ...base,
    type: "user.click",
    id: `E-click-${index}`,
    privacy: createBenchmarkPrivacy("actions"),
    data: {
      selector: "#save",
      x: index % 1400,
      y: index % 900
    }
  };
}

function createBenchmarkPrivacy(
  category: PrivacyDataCategory,
  highSensitivity = false
): PrivacyClassification {
  return {
    category,
    sensitivity: highSensitivity ? "high" : "low",
    redacted: true
  };
}

async function run(): Promise<void> {
  const eventCount = readPositiveInt("BENCH_PIPELINE_EVENTS", DEFAULT_EVENT_COUNT);
  const payloadBytes = readPositiveInt("BENCH_PAYLOAD_BYTES", DEFAULT_PAYLOAD_BYTES);
  const maxArchiveMb = readPositiveInt("BENCH_MAX_ARCHIVE_MB", DEFAULT_MAX_ARCHIVE_MB);
  const recentMinutes = readPositiveInt("BENCH_RECENT_MINUTES", DEFAULT_RECENT_MINUTES);
  const screenshotInterval = readPositiveInt(
    "BENCH_SCREENSHOT_INTERVAL",
    DEFAULT_SCREENSHOT_INTERVAL
  );
  const blobPool = readPositiveInt("BENCH_BLOB_POOL", DEFAULT_BLOB_POOL);
  const blobBytes = readPositiveInt("BENCH_BLOB_BYTES", DEFAULT_BLOB_BYTES);
  const maxArchiveBytes = maxArchiveMb * 1024 * 1024;
  const recentWindowMs = recentMinutes * 60 * 1000;

  console.log("WebBlackbox Pipeline Benchmarks");
  console.log("--------------------------------");
  console.log(`Events: ${eventCount.toLocaleString()}`);
  console.log(`Payload size: ${payloadBytes.toLocaleString()} bytes`);
  console.log(`Screenshot interval: every ${screenshotInterval.toLocaleString()} events`);
  console.log(`Export policy: no screenshots + ${maxArchiveMb} MB + ${recentMinutes} minutes`);

  const textPool = Array.from({ length: 64 }, (_, index) => {
    return createNoisyPayload(payloadBytes, index + 11);
  });
  const { pipeline, session, storage } = await createBenchmarkPipeline();
  const screenshotHashes: string[] = [];

  for (let index = 0; index < blobPool; index += 1) {
    const hash = await pipeline.putBlob("image/webp", createBinary(blobBytes, index + 1));
    screenshotHashes.push(hash);
  }

  const baseTime = Date.now() - 45 * 60 * 1000;
  const ingestStart = performance.now();

  for (let index = 0; index < eventCount; index += 1) {
    const event = createEvent(
      session.sid,
      index,
      baseTime + index * EVENT_STEP_MS,
      textPool,
      screenshotHashes,
      screenshotInterval,
      blobBytes
    );
    await pipeline.ingest(event);
  }

  await pipeline.flush();
  const ingestMs = performance.now() - ingestStart;
  const ingestOps = eventCount / Math.max(ingestMs / 1000, 0.000_001);

  const chunks = await storage.listChunks(session.sid);
  const storedBlobs = await storage.listBlobs();

  const fullExportStart = performance.now();
  const fullExport = await pipeline.exportBundle(FULL_EXPORT_OPTIONS);
  const fullExportMs = performance.now() - fullExportStart;

  const fullParseStart = performance.now();
  const fullParsed = await readWebBlackboxArchive(fullExport.bytes);
  const fullParseMs = performance.now() - fullParseStart;

  const filteredExportStart = performance.now();
  const filteredExport = await pipeline.exportBundle({
    includeScreenshots: false,
    maxArchiveBytes,
    recentWindowMs
  });
  const filteredExportMs = performance.now() - filteredExportStart;

  const filteredParseStart = performance.now();
  const filteredParsed = await readWebBlackboxArchive(filteredExport.bytes);
  const filteredParseMs = performance.now() - filteredParseStart;

  const exportDropRatio =
    fullExport.bytes.byteLength === 0
      ? 0
      : 1 - filteredExport.bytes.byteLength / fullExport.bytes.byteLength;
  const filteredEventDropRatio =
    fullParsed.events.length === 0
      ? 0
      : 1 - filteredParsed.events.length / fullParsed.events.length;

  const report: PipelineBenchmarkReport = {
    eventCount,
    payloadBytes,
    screenshotInterval,
    maxArchiveMb,
    recentMinutes,
    ingestDurationMs: ingestMs,
    ingestThroughputOpsPerSec: ingestOps,
    chunkCount: chunks.length,
    uniqueBlobCount: storedBlobs.length,
    fullExportDurationMs: fullExportMs,
    fullParseDurationMs: fullParseMs,
    fullExportBytes: fullExport.bytes.byteLength,
    fullExportEvents: fullParsed.events.length,
    filteredExportDurationMs: filteredExportMs,
    filteredParseDurationMs: filteredParseMs,
    filteredExportBytes: filteredExport.bytes.byteLength,
    filteredExportEvents: filteredParsed.events.length,
    archiveDropRatio: exportDropRatio,
    eventDropRatio: filteredEventDropRatio
  };

  if (isJsonOutputMode()) {
    console.log(JSON.stringify(report));
    return;
  }

  console.log("\nIngest");
  console.log(`  Duration: ${formatMs(ingestMs)}`);
  console.log(`  Throughput: ${formatOps(ingestOps)}`);
  console.log(`  Chunks persisted: ${chunks.length.toLocaleString()}`);
  console.log(`  Unique blobs persisted: ${storedBlobs.length.toLocaleString()}`);

  console.log("\nFull export");
  console.log(`  Duration: ${formatMs(fullExportMs)}`);
  console.log(`  Parse latency: ${formatMs(fullParseMs)}`);
  console.log(`  Size: ${toMb(fullExport.bytes.byteLength)}`);
  console.log(`  Events: ${fullParsed.events.length.toLocaleString()}`);

  console.log("\nFiltered export");
  console.log(`  Duration: ${formatMs(filteredExportMs)}`);
  console.log(`  Parse latency: ${formatMs(filteredParseMs)}`);
  console.log(`  Size: ${toMb(filteredExport.bytes.byteLength)}`);
  console.log(`  Events: ${filteredParsed.events.length.toLocaleString()}`);

  console.log("\nReduction");
  console.log(`  Archive size drop: ${(exportDropRatio * 100).toFixed(2)}%`);
  console.log(`  Event count drop: ${(filteredEventDropRatio * 100).toFixed(2)}%`);
}

function isJsonOutputMode(): boolean {
  return process.argv.includes("--json") || process.env.BENCH_OUTPUT === "json";
}

run().catch((error) => {
  console.error("Pipeline benchmark failed.");
  console.error(error);
  process.exitCode = 1;
});
