import { performance } from "node:perf_hooks";

import type { RecorderConfig, WebBlackboxEvent } from "@webblackbox/protocol";
import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";

import { EventRingBuffer, WebBlackboxRecorder } from "../src/index.js";

type BufferLike = {
  push(event: WebBlackboxEvent): void;
  size(): number;
  snapshot(): WebBlackboxEvent[];
};

type BenchmarkResult = {
  name: string;
  durationMs: number;
  throughputOpsPerSec: number;
  retainedEvents: number;
  heapDeltaMb: number;
};

const DEFAULT_RING_EVENTS = 120_000;
const DEFAULT_RECORDER_EVENTS = 160_000;
const DEFAULT_WINDOW_MINUTES = 1;
const EVENT_STEP_MS = 50;

class SpliceRingBuffer implements BufferLike {
  private readonly events: WebBlackboxEvent[] = [];

  private readonly maxWindowMs: number;

  public constructor(minutes: number) {
    this.maxWindowMs = minutes * 60 * 1000;
  }

  public push(event: WebBlackboxEvent): void {
    this.events.push(event);
    this.prune(event.t);
  }

  public size(): number {
    return this.events.length;
  }

  public snapshot(): WebBlackboxEvent[] {
    return [...this.events];
  }

  private prune(currentTime: number): void {
    const threshold = currentTime - this.maxWindowMs;
    const firstRetained = this.events.findIndex((candidate) => candidate.t >= threshold);

    if (firstRetained <= 0) {
      return;
    }

    this.events.splice(0, firstRetained);
  }
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = Number(raw);

  if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function heapUsedMb(): number {
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

function formatMs(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function formatOps(value: number): string {
  return `${Math.round(value).toLocaleString()} ops/s`;
}

function formatMb(value: number): string {
  return `${value.toFixed(2)} MB`;
}

function createNoticeEvent(id: string, timestamp: number, mono: number): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-bench",
    tab: 1,
    t: timestamp,
    mono,
    type: "sys.notice",
    id,
    data: {
      message: "ring-buffer-benchmark"
    }
  };
}

function runRingBufferBenchmark(name: string, createBuffer: () => BufferLike): BenchmarkResult {
  const eventCount = readPositiveInt("BENCH_RING_EVENTS", DEFAULT_RING_EVENTS);
  const baseTime = Date.now() - eventCount * EVENT_STEP_MS;
  const buffer = createBuffer();
  const heapBefore = heapUsedMb();
  const start = performance.now();

  for (let index = 0; index < eventCount; index += 1) {
    const timestamp = baseTime + index * EVENT_STEP_MS;
    buffer.push(createNoticeEvent(`E-${index}`, timestamp, timestamp - baseTime));
  }

  const durationMs = performance.now() - start;
  const heapAfter = heapUsedMb();

  return {
    name,
    durationMs,
    throughputOpsPerSec: eventCount / Math.max(durationMs / 1000, 0.000_001),
    retainedEvents: buffer.size(),
    heapDeltaMb: heapAfter - heapBefore
  };
}

function cloneRecorderConfig(config: RecorderConfig): RecorderConfig {
  return {
    ...config,
    sampling: {
      ...config.sampling
    },
    redaction: {
      ...config.redaction,
      redactHeaders: [...config.redaction.redactHeaders],
      redactCookieNames: [...config.redaction.redactCookieNames],
      redactBodyPatterns: [...config.redaction.redactBodyPatterns],
      blockedSelectors: [...config.redaction.blockedSelectors]
    },
    sitePolicies: [...config.sitePolicies]
  };
}

function runRecorderIngestBenchmark(): {
  result: BenchmarkResult;
  freezeCount: number;
  snapshotMs: number;
} {
  const eventCount = readPositiveInt("BENCH_RECORDER_EVENTS", DEFAULT_RECORDER_EVENTS);
  const baseTime = Date.now() - eventCount * 20;
  const config = cloneRecorderConfig(DEFAULT_RECORDER_CONFIG);
  config.ringBufferMinutes = DEFAULT_WINDOW_MINUTES;
  const recorder = new WebBlackboxRecorder(config);
  let freezeCount = 0;
  const heapBefore = heapUsedMb();
  const ingestStart = performance.now();

  for (let index = 0; index < eventCount; index += 1) {
    const timestamp = baseTime + index * 20;
    const mono = index * 20;
    let ingestResult;

    if (index % 4 === 0) {
      ingestResult = recorder.ingest({
        source: "content",
        rawType: "click",
        sid: "S-recorder-bench",
        tabId: 1,
        t: timestamp,
        mono,
        payload: {
          selector: "#save-button",
          x: index % 1280,
          y: index % 720
        }
      });
    } else if (index % 4 === 1) {
      ingestResult = recorder.ingest({
        source: "cdp",
        rawType: "Network.requestWillBeSent",
        sid: "S-recorder-bench",
        tabId: 1,
        t: timestamp,
        mono,
        payload: {
          requestId: `REQ-${index}`,
          request: {
            method: "POST",
            url: `https://example.test/api/items/${index % 100}`,
            headers: {
              authorization: "Bearer super-secret-token",
              "content-type": "application/json"
            },
            postData: `{"token":"abc-${index}","password":"pw-${index}"}`
          }
        }
      });
    } else if (index % 4 === 2) {
      ingestResult = recorder.ingest({
        source: "cdp",
        rawType: "Runtime.consoleAPICalled",
        sid: "S-recorder-bench",
        tabId: 1,
        t: timestamp,
        mono,
        payload: {
          type: "warning",
          args: [
            {
              type: "string",
              value: `console benchmark ${index}`
            }
          ]
        }
      });
    } else {
      ingestResult = recorder.ingest({
        source: "content",
        rawType: "longtask",
        sid: "S-recorder-bench",
        tabId: 1,
        t: timestamp,
        mono,
        payload: {
          duration: 240 + (index % 30)
        }
      });
    }

    if (ingestResult.freezeReason) {
      freezeCount += 1;
    }
  }

  const ingestDurationMs = performance.now() - ingestStart;
  const snapshotStart = performance.now();
  recorder.snapshotRingBuffer();
  const snapshotMs = performance.now() - snapshotStart;
  const heapAfter = heapUsedMb();

  return {
    result: {
      name: "WebBlackboxRecorder.ingest",
      durationMs: ingestDurationMs,
      throughputOpsPerSec: eventCount / Math.max(ingestDurationMs / 1000, 0.000_001),
      retainedEvents: recorder.getBufferedEventCount(),
      heapDeltaMb: heapAfter - heapBefore
    },
    freezeCount,
    snapshotMs
  };
}

function printResult(result: BenchmarkResult): void {
  console.log(`\n${result.name}`);
  console.log(`  Duration: ${formatMs(result.durationMs)}`);
  console.log(`  Throughput: ${formatOps(result.throughputOpsPerSec)}`);
  console.log(`  Retained events: ${result.retainedEvents.toLocaleString()}`);
  console.log(`  Heap delta: ${formatMb(result.heapDeltaMb)}`);
}

function main(): void {
  const ringEvents = readPositiveInt("BENCH_RING_EVENTS", DEFAULT_RING_EVENTS);
  const recorderEvents = readPositiveInt("BENCH_RECORDER_EVENTS", DEFAULT_RECORDER_EVENTS);
  console.log("WebBlackbox Recorder Benchmarks");
  console.log("--------------------------------");
  console.log(`Ring benchmark events: ${ringEvents.toLocaleString()}`);
  console.log(`Recorder ingest events: ${recorderEvents.toLocaleString()}`);
  console.log(`Ring window: ${DEFAULT_WINDOW_MINUTES} minute`);

  const spliceResult = runRingBufferBenchmark("RingBuffer baseline (splice pruning)", () => {
    return new SpliceRingBuffer(DEFAULT_WINDOW_MINUTES);
  });
  const optimizedResult = runRingBufferBenchmark(
    "RingBuffer optimized (head-index pruning)",
    () => {
      return new EventRingBuffer(DEFAULT_WINDOW_MINUTES);
    }
  );
  const recorder = runRecorderIngestBenchmark();

  printResult(spliceResult);
  printResult(optimizedResult);
  printResult(recorder.result);
  console.log(`\nRecorder snapshot() latency: ${formatMs(recorder.snapshotMs)}`);
  console.log(`Freeze signals observed during ingest: ${recorder.freezeCount.toLocaleString()}`);

  const speedup =
    optimizedResult.throughputOpsPerSec / Math.max(spliceResult.throughputOpsPerSec, 0.000_001);
  console.log(`\nRing buffer speedup (optimized / baseline): ${speedup.toFixed(2)}x`);
}

main();
