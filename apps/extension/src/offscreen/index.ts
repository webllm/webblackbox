import { FlightRecorderPipeline, IndexedDbPipelineStorage } from "@webblackbox/pipeline";
import type { RedactionProfile, SessionMetadata, WebBlackboxEvent } from "@webblackbox/protocol";

import { getChromeApi } from "../shared/chrome-api.js";
import { createExtensionI18n } from "../shared/i18n.js";
import { PORT_NAMES } from "../shared/messages.js";

type OffscreenPipelineRequest = {
  kind: "sw.pipeline-request";
  requestId: string;
  op: "start" | "ingest" | "ingestBatch" | "flush" | "putBlob" | "exportDownload" | "close";
  sid: string;
  session?: SessionMetadata;
  redactionProfile?: RedactionProfile;
  event?: WebBlackboxEvent;
  events?: WebBlackboxEvent[];
  mime?: string;
  bytes?: Uint8Array;
  passphrase?: string;
  includeScreenshots?: boolean;
  maxArchiveBytes?: number;
  recentWindowMs?: number;
  purge?: boolean;
};

type OffscreenPipelineResponse = {
  kind: "offscreen.pipeline-response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type OffscreenState = {
  active: boolean;
  activeSessions: number;
  updatedAt: number | null;
};

const chromeApi = getChromeApi();
createExtensionI18n({
  pageTitleKey: "pageTitleOffscreen"
});
const port = chromeApi?.runtime?.connect({ name: PORT_NAMES.offscreen });
const pipelines = new Map<string, FlightRecorderPipeline>();
const EXPORT_OBJECT_URL_TTL_MS = 90_000;

const state: OffscreenState = {
  active: false,
  activeSessions: 0,
  updatedAt: null
};

console.info("[WebBlackbox] offscreen pipeline initialized");

port?.onMessage.addListener((message) => {
  if (message && typeof message === "object") {
    const kind = (message as { kind?: unknown }).kind;

    if (kind === "sw.recording-status") {
      const active = (message as { active?: unknown }).active;
      state.active = active === true;
      console.info("[WebBlackbox] offscreen status", message);
      return;
    }

    if (kind === "sw.pipeline-status") {
      const activeSessions = (message as { activeSessions?: unknown }).activeSessions;
      const updatedAt = (message as { updatedAt?: unknown }).updatedAt;

      state.activeSessions =
        typeof activeSessions === "number" && Number.isFinite(activeSessions) ? activeSessions : 0;
      state.updatedAt = typeof updatedAt === "number" ? updatedAt : Date.now();

      console.info("[WebBlackbox] offscreen pipeline status", {
        active: state.active,
        activeSessions: state.activeSessions,
        updatedAt: state.updatedAt
      });
      return;
    }

    if (kind === "sw.pipeline-request") {
      void handlePipelineRequest(message as OffscreenPipelineRequest);
    }
  }
});

postToSw({
  kind: "offscreen.ready",
  t: Date.now()
});

async function handlePipelineRequest(message: OffscreenPipelineRequest): Promise<void> {
  try {
    const result = await processPipelineRequest(message);
    postPipelineResponse({
      kind: "offscreen.pipeline-response",
      requestId: message.requestId,
      ok: true,
      result
    });
  } catch (error) {
    postPipelineResponse({
      kind: "offscreen.pipeline-response",
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function processPipelineRequest(message: OffscreenPipelineRequest): Promise<unknown> {
  if (message.op === "start") {
    if (!message.session) {
      throw new Error("Missing session metadata for pipeline start.");
    }

    if (pipelines.has(message.sid)) {
      return null;
    }

    const storage = new IndexedDbPipelineStorage("webblackbox-flight-recorder");
    const pipeline = new FlightRecorderPipeline({
      session: message.session,
      storage,
      maxChunkBytes: 512 * 1024,
      redactionProfile: message.redactionProfile
    });

    await pipeline.start();
    pipelines.set(message.sid, pipeline);
    return null;
  }

  const pipeline = pipelines.get(message.sid);

  if (!pipeline) {
    throw new Error(`Pipeline session not found: ${message.sid}`);
  }

  if (message.op === "ingest") {
    if (!message.event) {
      throw new Error("Missing event payload for pipeline ingest.");
    }

    await pipeline.ingest(message.event);
    return null;
  }

  if (message.op === "ingestBatch") {
    if (!Array.isArray(message.events) || message.events.length === 0) {
      return null;
    }

    await pipeline.ingestBatch(message.events);
    return null;
  }

  if (message.op === "flush") {
    await pipeline.flush();
    return null;
  }

  if (message.op === "putBlob") {
    if (!message.mime) {
      throw new Error("Missing mime for blob write.");
    }

    const bytes = asUint8Array(message.bytes);

    if (!bytes) {
      throw new Error("Missing blob bytes.");
    }

    return pipeline.putBlob(message.mime, bytes);
  }

  if (message.op === "exportDownload") {
    const exported = await pipeline.exportBundle({
      passphrase: message.passphrase,
      includeScreenshots: message.includeScreenshots,
      maxArchiveBytes: message.maxArchiveBytes,
      recentWindowMs: message.recentWindowMs
    });
    return downloadExportedBundle(exported.fileName, exported.bytes, exported.integrity);
  }

  if (message.op === "close") {
    await pipeline.close({
      purge: message.purge === true
    });
    pipelines.delete(message.sid);
    return null;
  }

  throw new Error(`Unsupported pipeline operation: ${message.op}`);
}

function postPipelineResponse(message: OffscreenPipelineResponse): void {
  postToSw(message);
}

function postToSw(message: unknown): void {
  try {
    port?.postMessage(message);
  } catch {
    void 0;
  }
}

async function downloadExportedBundle(
  fileName: string,
  bytes: Uint8Array,
  integrity: unknown
): Promise<{
  fileName: string;
  sizeBytes: number;
  downloadUrl: string;
  integrity: unknown;
}> {
  const blobPart: BlobPart =
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
      ? bytes.buffer
      : Uint8Array.from(bytes);
  const blob = new Blob([blobPart], { type: "application/zip" });
  const downloadUrl = URL.createObjectURL(blob);

  scheduleObjectUrlRevoke(downloadUrl);

  return {
    fileName,
    sizeBytes: bytes.byteLength,
    downloadUrl,
    integrity
  };
}

function scheduleObjectUrlRevoke(url: string): void {
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, EXPORT_OBJECT_URL_TTL_MS);
}

function asUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  if (Array.isArray(value)) {
    return Uint8Array.from(value, (entry) =>
      typeof entry === "number" && Number.isFinite(entry) ? entry & 0xff : 0
    );
  }

  if (value === null || typeof value !== "object") {
    return null;
  }

  const row = value as Record<string, unknown>;
  const numericKeys = Object.keys(row)
    .filter((key) => /^\d+$/.test(key))
    .map((key) => Number(key))
    .sort((left, right) => left - right);

  if (numericKeys.length === 0) {
    return null;
  }

  const maxIndex = numericKeys[numericKeys.length - 1];

  if (typeof maxIndex !== "number" || !Number.isFinite(maxIndex)) {
    return null;
  }

  const bytes = new Uint8Array(maxIndex + 1);

  for (const index of numericKeys) {
    const rawByte = row[String(index)];

    if (typeof rawByte !== "number" || !Number.isFinite(rawByte)) {
      return null;
    }

    bytes[index] = rawByte & 0xff;
  }

  return bytes;
}
