import type {
  OffscreenScreenRecordingChunkMessage,
  ScreenRecordingChunkAckMessage
} from "../shared/messages.js";

const SCREEN_RECORDING_CHUNK_DELIVERY_MAX_PENDING = 64;
const SCREEN_RECORDING_CHUNK_MAX_BYTES = 64 * 1024 * 1024;
const SCREEN_RECORDING_CHUNK_HASH_PATTERN = /^[a-f0-9]{64}$/u;

export type PortBoundScreenRecording = {
  recorder: Pick<MediaRecorder, "state" | "pause" | "resume">;
  stream: Pick<MediaStream, "getTracks">;
  stopping: boolean;
  pausedForPortDisconnect: boolean;
};

export type SessionBoundScreenRecording = PortBoundScreenRecording & { sid: string };
export type StopQuiescedScreenRecording = PortBoundScreenRecording & { quiescedForStop: boolean };

export type ScreenRecordingHandshakeFailure<TRecording extends SessionBoundScreenRecording> = {
  recording: TRecording;
  reason: "service-worker-session-not-active" | "service-worker-reconnect-failed";
};

type PendingScreenRecordingChunkDelivery = {
  readonly message: OffscreenScreenRecordingChunkMessage;
  readonly promise: Promise<ScreenRecordingChunkAckMessage>;
  readonly resolve: (ack: ScreenRecordingChunkAckMessage) => void;
  readonly reject: (error: Error) => void;
};

/** Retains exact video chunks until the worker proves their durable pipeline commit. */
export class ScreenRecordingChunkDeliveryRegistry {
  private readonly pending = new Map<string, PendingScreenRecordingChunkDelivery>();

  public track(
    message: OffscreenScreenRecordingChunkMessage
  ): Promise<ScreenRecordingChunkAckMessage> {
    assertScreenRecordingChunkMessage(message);
    const key = screenRecordingChunkDeliveryKey(message.sid, message.recordingId, message.index);
    const existing = this.pending.get(key);

    if (existing) {
      if (!sameScreenRecordingChunkMessage(existing.message, message)) {
        throw new Error(
          "Screen recording chunk identity was reused with different payload metadata."
        );
      }
      return existing.promise;
    }
    if (this.pending.size >= SCREEN_RECORDING_CHUNK_DELIVERY_MAX_PENDING) {
      throw new Error("Screen recording durable delivery backlog is full.");
    }

    let resolve!: (ack: ScreenRecordingChunkAckMessage) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<ScreenRecordingChunkAckMessage>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.pending.set(key, { message, promise, resolve, reject });
    return promise;
  }

  public acknowledge(raw: unknown): boolean {
    const ack = parseScreenRecordingChunkAck(raw);
    if (!ack) {
      return false;
    }

    const key = screenRecordingChunkDeliveryKey(ack.sid, ack.recordingId, ack.index);
    const delivery = this.pending.get(key);
    if (!delivery || delivery.message.size !== ack.size) {
      return false;
    }

    this.pending.delete(key);
    delivery.resolve(ack);
    return true;
  }

  public replay(post: (message: OffscreenScreenRecordingChunkMessage) => boolean): number {
    let posted = 0;
    for (const delivery of this.pending.values()) {
      try {
        if (post(delivery.message)) {
          posted += 1;
        }
      } catch {
        // The resilient port reconnect path will invoke replay again.
      }
    }
    return posted;
  }

  public failRecording(sid: string, recordingId: string, error: Error): number {
    let failed = 0;
    for (const [key, delivery] of this.pending) {
      if (delivery.message.sid !== sid || delivery.message.recordingId !== recordingId) {
        continue;
      }
      this.pending.delete(key);
      delivery.reject(error);
      failed += 1;
    }
    return failed;
  }

  public get size(): number {
    return this.pending.size;
  }
}

/** Parses an active-session list only after the current worker has finished state restoration. */
export function parseActiveScreenRecordingSessionIds(status: unknown): ReadonlySet<string> | null {
  if (status === null || typeof status !== "object" || Array.isArray(status)) {
    return null;
  }

  const record = status as Record<string, unknown>;
  const sessions = record.sessions;
  if (
    record.runtimeStateRestored !== true ||
    !Array.isArray(sessions) ||
    sessions.length > 10_000
  ) {
    return null;
  }

  const activeSessionIds = new Set<string>();
  for (const item of sessions) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }

    const record = item as Record<string, unknown>;
    if (typeof record.sid !== "string" || record.sid.length === 0 || record.sid.length > 256) {
      return null;
    }
    if (record.active !== true) {
      return null;
    }
    activeSessionIds.add(record.sid);
  }

  return activeSessionIds;
}

/** Resumes only recordings claimed by the restored worker and reports every fail-closed stop. */
export function reconcileScreenRecordingsWithWorkerSessions<
  TRecording extends SessionBoundScreenRecording
>(
  recordings: Iterable<TRecording>,
  activeSessionIds: ReadonlySet<string>
): ScreenRecordingHandshakeFailure<TRecording>[] {
  const failures: ScreenRecordingHandshakeFailure<TRecording>[] = [];
  for (const recording of recordings) {
    if (!activeSessionIds.has(recording.sid)) {
      failures.push({ recording, reason: "service-worker-session-not-active" });
      continue;
    }
    if (!resumeScreenRecordingAfterPortReconnect(recording)) {
      failures.push({ recording, reason: "service-worker-reconnect-failed" });
    }
  }
  return failures;
}

/** Suspends sensitive media production while the service worker cannot receive chunks. */
export function pauseScreenRecordingForPortDisconnect(
  recording: PortBoundScreenRecording
): boolean {
  if (recording.stopping) {
    return true;
  }

  for (const track of recording.stream.getTracks()) {
    track.enabled = false;
  }

  try {
    if (recording.recorder.state === "recording") {
      recording.recorder.pause();
    } else if (recording.recorder.state !== "paused") {
      return false;
    }
    recording.pausedForPortDisconnect = true;
    return true;
  } catch {
    return false;
  }
}

/** Pauses pixel production at stop intent without destroying the recorder
 * before the service worker has persisted its stopping tombstone. */
export function quiesceScreenRecordingForStop(recording: StopQuiescedScreenRecording): boolean {
  recording.quiescedForStop = true;
  return pauseScreenRecordingForPortDisconnect(recording);
}

export function quiesceExpectedScreenRecordingForStop(
  recording: (StopQuiescedScreenRecording & { recordingId: string }) | undefined,
  expectedRecordingId?: string
): boolean {
  if (!recording) {
    return true;
  }

  const quiesced = quiesceScreenRecordingForStop(recording);
  if (expectedRecordingId && recording.recordingId !== expectedRecordingId) {
    throw new Error("Screen recording identity changed while stop quiescence was requested.");
  }
  if (!quiesced) {
    throw new Error("Screen recording could not be quiesced for stop.");
  }
  return true;
}

/** Resumes only recordings that this disconnect path suspended. */
export function resumeScreenRecordingAfterPortReconnect(
  recording: PortBoundScreenRecording
): boolean {
  if (!recording.pausedForPortDisconnect || recording.stopping) {
    return true;
  }

  try {
    if (recording.recorder.state === "paused") {
      recording.recorder.resume();
    } else if (recording.recorder.state !== "recording") {
      return false;
    }
    for (const track of recording.stream.getTracks()) {
      track.enabled = true;
    }
    recording.pausedForPortDisconnect = false;
    return true;
  } catch {
    return false;
  }
}

function parseScreenRecordingChunkAck(raw: unknown): ScreenRecordingChunkAckMessage | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const row = raw as Record<string, unknown>;
  if (
    Object.keys(row).some(
      (key) => !["chunkId", "index", "kind", "recordingId", "sid", "size"].includes(key)
    ) ||
    row.kind !== "sw.screen-recording-chunk-ack" ||
    !isBoundedNonEmptyString(row.sid, 256) ||
    !isBoundedNonEmptyString(row.recordingId, 256) ||
    !Number.isSafeInteger(row.index) ||
    (row.index as number) < 0 ||
    !Number.isSafeInteger(row.size) ||
    (row.size as number) <= 0 ||
    typeof row.chunkId !== "string" ||
    !SCREEN_RECORDING_CHUNK_HASH_PATTERN.test(row.chunkId)
  ) {
    return null;
  }

  return {
    kind: "sw.screen-recording-chunk-ack",
    sid: row.sid,
    recordingId: row.recordingId,
    index: row.index as number,
    size: row.size as number,
    chunkId: row.chunkId
  };
}

function assertScreenRecordingChunkMessage(message: OffscreenScreenRecordingChunkMessage): void {
  if (
    message.kind !== "offscreen.screen-recording-chunk" ||
    !isBoundedNonEmptyString(message.sid, 256) ||
    !isBoundedNonEmptyString(message.recordingId, 256) ||
    !Number.isSafeInteger(message.index) ||
    message.index < 0 ||
    !isBoundedNonEmptyString(message.mime, 256) ||
    !(message.bytes instanceof Uint8Array) ||
    message.bytes.byteLength <= 0 ||
    message.bytes.byteLength > SCREEN_RECORDING_CHUNK_MAX_BYTES ||
    message.size !== message.bytes.byteLength
  ) {
    throw new Error("Invalid screen recording chunk delivery.");
  }
}

function sameScreenRecordingChunkMessage(
  first: OffscreenScreenRecordingChunkMessage,
  second: OffscreenScreenRecordingChunkMessage
): boolean {
  return (
    first.sid === second.sid &&
    first.recordingId === second.recordingId &&
    first.index === second.index &&
    first.mime === second.mime &&
    first.size === second.size &&
    Object.is(first.startOffsetMs, second.startOffsetMs) &&
    Object.is(first.endOffsetMs, second.endOffsetMs) &&
    Object.is(first.durationMs, second.durationMs) &&
    first.bytes === second.bytes
  );
}

function screenRecordingChunkDeliveryKey(sid: string, recordingId: string, index: number): string {
  return JSON.stringify([sid, recordingId, index]);
}

function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}
