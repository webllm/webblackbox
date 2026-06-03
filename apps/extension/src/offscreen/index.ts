import { FlightRecorderPipeline, IndexedDbPipelineStorage } from "@webblackbox/pipeline";
import type {
  CapturePolicy,
  PrivacyScannerResult,
  RedactionProfile,
  SessionMetadata,
  WebBlackboxEvent
} from "@webblackbox/protocol";

import { getChromeApi } from "../shared/chrome-api.js";
import { createExtensionI18n } from "../shared/i18n.js";
import { PORT_NAMES } from "../shared/messages.js";

type OffscreenPipelineRequest = {
  kind: "sw.pipeline-request";
  requestId: string;
  op:
    | "start"
    | "ingest"
    | "ingestBatch"
    | "flush"
    | "putBlob"
    | "exportDownload"
    | "close"
    | "startScreenRecording"
    | "stopScreenRecording";
  sid: string;
  session?: SessionMetadata;
  redactionProfile?: RedactionProfile;
  capturePolicy?: CapturePolicy;
  event?: WebBlackboxEvent;
  events?: WebBlackboxEvent[];
  mime?: string;
  bytes?: Uint8Array;
  passphrase?: string;
  includeScreenshots?: boolean;
  includeScreenRecordings?: boolean;
  maxArchiveBytes?: number;
  recentWindowMs?: number;
  allowPlaintextLocalExport?: boolean;
  purge?: boolean;
  recordingId?: string;
  streamId?: string;
  source?: "tab";
  reason?: string;
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

type OffscreenScreenRecordingStartResult = {
  recordingId: string;
  source: "tab";
  mime: string;
  width?: number;
  height?: number;
  frameRate?: number;
  audio: boolean;
};

type OffscreenScreenRecordingStopResult = {
  recordingId: string;
  mime: string;
  chunkCount: number;
  size: number;
  durationMs: number;
  width?: number;
  height?: number;
  reason?: string;
};

type OffscreenScreenRecordingState = {
  sid: string;
  recordingId: string;
  source: "tab";
  stream: MediaStream;
  recorder: MediaRecorder;
  mime: string;
  startedAt: number;
  width?: number;
  height?: number;
  frameRate?: number;
  nextChunkIndex: number;
  postedChunkCount: number;
  sizeBytes: number;
  pendingChunks: Set<Promise<void>>;
  stopping: boolean;
  stopPromise: Promise<OffscreenScreenRecordingStopResult> | null;
};

const chromeApi = getChromeApi();
createExtensionI18n({
  pageTitleKey: "pageTitleOffscreen"
});
const port = chromeApi?.runtime?.connect({ name: PORT_NAMES.offscreen });
const pipelines = new Map<string, FlightRecorderPipeline>();
const screenRecordings = new Map<string, OffscreenScreenRecordingState>();
const EXPORT_OBJECT_URL_TTL_MS = 90_000;
const SERVICE_WORKER_KEEPALIVE_INTERVAL_MS = 20_000;
const SCREEN_RECORDING_TIMESLICE_MS = 1_000;
const SCREEN_RECORDING_STOP_TIMEOUT_MS = 10_000;
const SCREEN_RECORDING_MAX_FRAME_RATE = 30;
const SCREEN_RECORDING_VIDEO_BITS_PER_SECOND = 3_500_000;
const SCREEN_RECORDING_MIME_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm"
];

const state: OffscreenState = {
  active: false,
  activeSessions: 0,
  updatedAt: null
};

let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

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
      syncServiceWorkerKeepalive();

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

port?.onDisconnect?.addListener(() => {
  stopServiceWorkerKeepalive();
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
      redactionProfile: message.redactionProfile,
      capturePolicy: message.capturePolicy
    });

    await pipeline.start();
    pipelines.set(message.sid, pipeline);
    return null;
  }

  const pipeline = pipelines.get(message.sid);

  if (!pipeline) {
    throw new Error(`Pipeline session not found: ${message.sid}`);
  }

  if (message.op === "startScreenRecording") {
    return startOffscreenScreenRecording(message);
  }

  if (message.op === "stopScreenRecording") {
    return stopOffscreenScreenRecording(
      message.sid,
      message.recordingId,
      message.reason ?? "requested",
      false
    );
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
      includeScreenRecordings: message.includeScreenRecordings,
      maxArchiveBytes: message.maxArchiveBytes,
      recentWindowMs: message.recentWindowMs,
      allowPlaintextLocalExport: message.allowPlaintextLocalExport
    });
    return downloadExportedBundle(
      exported.fileName,
      exported.bytes,
      exported.integrity,
      exported.privacyManifest.scanner
    );
  }

  if (message.op === "close") {
    await stopOffscreenScreenRecording(
      message.sid,
      undefined,
      message.purge === true ? "pipeline-purge" : "pipeline-close",
      false
    ).catch((error) => {
      console.warn("[WebBlackbox] failed to stop offscreen screen recording", error);
    });
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

function syncServiceWorkerKeepalive(): void {
  if (state.activeSessions > 0 || screenRecordings.size > 0) {
    startServiceWorkerKeepalive();
    return;
  }

  stopServiceWorkerKeepalive();
}

function startServiceWorkerKeepalive(): void {
  if (keepaliveTimer !== null) {
    return;
  }

  postServiceWorkerKeepalive();
  keepaliveTimer = setInterval(postServiceWorkerKeepalive, SERVICE_WORKER_KEEPALIVE_INTERVAL_MS);
}

function stopServiceWorkerKeepalive(): void {
  if (keepaliveTimer === null) {
    return;
  }

  clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

function postServiceWorkerKeepalive(): void {
  postToSw({
    kind: "offscreen.keepalive",
    activeSessions: state.activeSessions,
    t: Date.now()
  });
}

async function startOffscreenScreenRecording(
  message: OffscreenPipelineRequest
): Promise<OffscreenScreenRecordingStartResult> {
  const recordingId = normalizeRequiredString(message.recordingId, "recording id");
  const streamId = normalizeRequiredString(message.streamId, "tab capture stream id");
  const existing = screenRecordings.get(message.sid);

  if (existing) {
    if (existing.recordingId !== recordingId) {
      throw new Error(`Screen recording already active for session: ${message.sid}`);
    }

    return toScreenRecordingStartResult(existing);
  }

  let stream: MediaStream | null = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia(
      createTabCaptureConstraints(streamId, SCREEN_RECORDING_MAX_FRAME_RATE)
    );

    const videoTrack = stream.getVideoTracks()[0];

    if (!videoTrack) {
      throw new Error("Tab capture stream did not include a video track.");
    }

    const settings = videoTrack.getSettings();
    const mime = selectScreenRecordingMime();
    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: SCREEN_RECORDING_VIDEO_BITS_PER_SECOND
    });
    const recording: OffscreenScreenRecordingState = {
      sid: message.sid,
      recordingId,
      source: "tab",
      stream,
      recorder,
      mime: recorder.mimeType || mime,
      startedAt: performance.now(),
      width: normalizePositiveInteger(settings.width),
      height: normalizePositiveInteger(settings.height),
      frameRate: normalizePositiveNumber(settings.frameRate),
      nextChunkIndex: 0,
      postedChunkCount: 0,
      sizeBytes: 0,
      pendingChunks: new Set(),
      stopping: false,
      stopPromise: null
    };

    recorder.ondataavailable = (event) => {
      handleScreenRecordingData(recording, event.data);
    };
    recorder.onerror = (event) => {
      postScreenRecordingError(
        recording.sid,
        recording.recordingId,
        extractErrorFromRecorderEvent(event),
        "recorder"
      );
    };
    videoTrack.addEventListener("ended", () => {
      if (!recording.stopping) {
        void stopOffscreenScreenRecording(
          recording.sid,
          recording.recordingId,
          "track-ended",
          true
        );
      }
    });

    screenRecordings.set(message.sid, recording);
    syncServiceWorkerKeepalive();
    recorder.start(SCREEN_RECORDING_TIMESLICE_MS);

    return toScreenRecordingStartResult(recording);
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    postScreenRecordingError(message.sid, recordingId, error, "start");
    throw error;
  }
}

async function stopOffscreenScreenRecording(
  sid: string,
  recordingId: string | undefined,
  reason: string,
  notifyEnded: boolean
): Promise<OffscreenScreenRecordingStopResult> {
  const recording = screenRecordings.get(sid);

  if (!recording) {
    if (!recordingId) {
      throw new Error(`Screen recording not found for session: ${sid}`);
    }

    return {
      recordingId,
      mime: "video/webm",
      chunkCount: 0,
      size: 0,
      durationMs: 0,
      reason
    };
  }

  if (recordingId && recording.recordingId !== recordingId) {
    throw new Error(`Screen recording id mismatch for session: ${sid}`);
  }

  if (!recording.stopPromise) {
    recording.stopPromise = stopActiveOffscreenScreenRecording(recording, reason);
  }

  const result = await recording.stopPromise;

  if (notifyEnded) {
    postToSw({
      kind: "offscreen.screen-recording-ended",
      sid,
      result
    });
  }

  return result;
}

async function stopActiveOffscreenScreenRecording(
  recording: OffscreenScreenRecordingState,
  reason: string
): Promise<OffscreenScreenRecordingStopResult> {
  recording.stopping = true;

  return new Promise((resolve) => {
    let finished = false;
    const timeout = setTimeout(() => {
      void finish();
    }, SCREEN_RECORDING_STOP_TIMEOUT_MS);

    const finish = async (): Promise<void> => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timeout);
      await waitForOffscreenScreenRecordingChunks(recording);
      cleanupOffscreenScreenRecording(recording);
      resolve(toScreenRecordingStopResult(recording, reason));
    };

    recording.recorder.addEventListener(
      "stop",
      () => {
        void finish();
      },
      { once: true }
    );

    try {
      if (recording.recorder.state !== "inactive") {
        recording.recorder.requestData();
        recording.recorder.stop();
        return;
      }
    } catch (error) {
      postScreenRecordingError(recording.sid, recording.recordingId, error, "stop");
    }

    void finish();
  });
}

function handleScreenRecordingData(
  recording: OffscreenScreenRecordingState,
  blob: Blob | null | undefined
): void {
  if (!blob || blob.size <= 0) {
    return;
  }

  const index = recording.nextChunkIndex;
  const startOffsetMs = Math.max(0, Math.round(performance.now() - recording.startedAt));
  recording.nextChunkIndex += 1;

  const task = (async () => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const endOffsetMs = Math.max(0, Math.round(performance.now() - recording.startedAt));
    recording.postedChunkCount += 1;
    recording.sizeBytes += bytes.byteLength;

    postToSw({
      kind: "offscreen.screen-recording-chunk",
      sid: recording.sid,
      recordingId: recording.recordingId,
      index,
      mime: blob.type || recording.mime,
      bytes,
      size: bytes.byteLength,
      startOffsetMs,
      endOffsetMs,
      durationMs: Math.max(0, endOffsetMs - startOffsetMs)
    });
  })();

  recording.pendingChunks.add(task);
  task.then(
    () => {
      recording.pendingChunks.delete(task);
    },
    (error) => {
      recording.pendingChunks.delete(task);
      postScreenRecordingError(recording.sid, recording.recordingId, error, "chunk");
    }
  );
}

async function waitForOffscreenScreenRecordingChunks(
  recording: OffscreenScreenRecordingState
): Promise<void> {
  while (recording.pendingChunks.size > 0) {
    await Promise.allSettled([...recording.pendingChunks]);
  }
}

function cleanupOffscreenScreenRecording(recording: OffscreenScreenRecordingState): void {
  recording.stream.getTracks().forEach((track) => track.stop());

  if (screenRecordings.get(recording.sid) === recording) {
    screenRecordings.delete(recording.sid);
  }

  syncServiceWorkerKeepalive();
}

function createTabCaptureConstraints(streamId: string, frameRate: number): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxFrameRate: frameRate
      }
    } as unknown as MediaTrackConstraints
  };
}

function selectScreenRecordingMime(): string {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder is unavailable in the offscreen document.");
  }

  for (const mime of SCREEN_RECORDING_MIME_CANDIDATES) {
    if (
      typeof MediaRecorder.isTypeSupported !== "function" ||
      MediaRecorder.isTypeSupported(mime)
    ) {
      return mime;
    }
  }

  return "video/webm";
}

function toScreenRecordingStartResult(
  recording: OffscreenScreenRecordingState
): OffscreenScreenRecordingStartResult {
  return {
    recordingId: recording.recordingId,
    source: recording.source,
    mime: recording.mime,
    width: recording.width,
    height: recording.height,
    frameRate: recording.frameRate,
    audio: recording.stream.getAudioTracks().length > 0
  };
}

function toScreenRecordingStopResult(
  recording: OffscreenScreenRecordingState,
  reason: string
): OffscreenScreenRecordingStopResult {
  return {
    recordingId: recording.recordingId,
    mime: recording.mime,
    chunkCount: recording.postedChunkCount,
    size: recording.sizeBytes,
    durationMs: Math.max(0, Math.round(performance.now() - recording.startedAt)),
    width: recording.width,
    height: recording.height,
    reason
  };
}

function postScreenRecordingError(
  sid: string,
  recordingId: string | undefined,
  error: unknown,
  stage: string
): void {
  postToSw({
    kind: "offscreen.screen-recording-error",
    sid,
    recordingId,
    name: error instanceof Error ? error.name : undefined,
    message: error instanceof Error ? error.message : String(error),
    stage
  });
}

function extractErrorFromRecorderEvent(event: Event): unknown {
  const error = (event as Event & { error?: unknown }).error;
  return error instanceof Error || typeof error === "string" ? error : event;
}

function normalizeRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing ${label}.`);
  }

  return value;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function downloadExportedBundle(
  fileName: string,
  bytes: Uint8Array,
  integrity: unknown,
  privacyScanner: PrivacyScannerResult
): Promise<{
  fileName: string;
  sizeBytes: number;
  downloadUrl: string;
  integrity: unknown;
  privacyScanner: PrivacyScannerResult;
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
    integrity,
    privacyScanner
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
