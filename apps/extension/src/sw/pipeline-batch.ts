export type PipelineBatchInFlight<TEvent> = Readonly<{
  operationId: string;
  events: readonly TEvent[];
}>;

type OffscreenPipelineOperation =
  | "start"
  | "ingest"
  | "ingestBatch"
  | "ingestBatchDurably"
  | "ingestBatchWithDelivery"
  | "flush"
  | "getResumeState"
  | "getDeliveryReceipt"
  | "commitDeliveryProgress"
  | "putBlob"
  | "exportDownload"
  | "close"
  | "getScreenRecordingStatus"
  | "quiesceScreenRecording"
  | "startScreenRecording"
  | "stopScreenRecording";

export type OffscreenPipelineRecoveryState = Readonly<{
  captureOpen: boolean;
  stopping: boolean;
  stopped: boolean;
}>;

export function shouldRecoverOffscreenPipeline(
  state: OffscreenPipelineRecoveryState | null,
  trigger: "automatic" | "request"
): boolean {
  if (!state) {
    return false;
  }

  // Automatic reconnects must not revive closed capture. An explicit pipeline
  // request still needs its durable storage session while stop/export/purge is
  // finishing, even though the page-capture fence is already closed.
  return trigger === "request" || (state.captureOpen && !state.stopping && !state.stopped);
}

export function acquirePipelineBatch<TEvent>(
  current: PipelineBatchInFlight<TEvent> | null,
  buffer: readonly TEvent[],
  maxEvents: number,
  createOperationId: () => string,
  validateOperationId: (operationId: unknown) => string
): PipelineBatchInFlight<TEvent> | null {
  if (current) {
    return current;
  }

  if (!Number.isSafeInteger(maxEvents) || maxEvents <= 0) {
    throw new Error("Pipeline batch size must be a positive safe integer.");
  }

  if (buffer.length === 0) {
    return null;
  }

  return Object.freeze({
    operationId: validateOperationId(createOperationId()),
    events: Object.freeze(buffer.slice(0, maxEvents))
  });
}

export function acknowledgePipelineBatch<TEvent>(
  buffer: TEvent[],
  batch: PipelineBatchInFlight<TEvent>
): void {
  if (buffer.length < batch.events.length) {
    throw new Error("Pipeline buffer no longer contains the acknowledged batch.");
  }

  for (let index = 0; index < batch.events.length; index += 1) {
    if (buffer[index] !== batch.events[index]) {
      throw new Error("Pipeline buffer changed before the in-flight batch was acknowledged.");
    }
  }

  buffer.splice(0, batch.events.length);
}

export function shouldRetryOffscreenPipelineRequest(
  op: OffscreenPipelineOperation,
  error: unknown
): boolean {
  if (op === "start") {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);

  if (
    message.includes("Pipeline session not found") ||
    message.includes("Offscreen pipeline is unavailable")
  ) {
    return true;
  }

  if (message.includes("Offscreen pipeline disconnected")) {
    // A disconnect can happen after the offscreen document has started the
    // operation. Replaying a download with an unknown result can create a
    // duplicate user-visible file, so require the caller to resolve it.
    return op !== "exportDownload";
  }

  return (
    (op === "ingest" ||
      op === "ingestBatch" ||
      op === "ingestBatchDurably" ||
      op === "ingestBatchWithDelivery" ||
      op === "commitDeliveryProgress" ||
      op === "getDeliveryReceipt") &&
    message.includes("Timed out waiting for offscreen response")
  );
}
