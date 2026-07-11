import { describe, expect, it } from "vitest";

import {
  acknowledgePipelineBatch,
  acquirePipelineBatch,
  shouldRecoverOffscreenPipeline,
  shouldRetryOffscreenPipelineRequest,
  type PipelineBatchInFlight
} from "./pipeline-batch.js";

describe("pipeline batch retry state", () => {
  it("recovers closed pipeline sessions only for an explicit finishing request", () => {
    const active = { captureOpen: true, stopping: false, stopped: false };
    const stopping = { captureOpen: false, stopping: true, stopped: false };
    const stopped = { captureOpen: false, stopping: false, stopped: true };

    expect(shouldRecoverOffscreenPipeline(active, "automatic")).toBe(true);
    expect(shouldRecoverOffscreenPipeline(stopping, "automatic")).toBe(false);
    expect(shouldRecoverOffscreenPipeline(stopped, "automatic")).toBe(false);
    expect(shouldRecoverOffscreenPipeline(stopping, "request")).toBe(true);
    expect(shouldRecoverOffscreenPipeline(stopped, "request")).toBe(true);
    expect(shouldRecoverOffscreenPipeline(null, "request")).toBe(false);
  });

  it("keeps a failed batch fixed while new events append, then advances after acknowledgement", () => {
    const buffer = [{ id: 1 }, { id: 2 }];
    let sequence = 0;
    const createOperationId = (): string => `I-operation-${++sequence}`;
    const validateOperationId = (value: unknown): string => String(value);
    let inFlight: PipelineBatchInFlight<{ id: number }> | null = acquirePipelineBatch(
      null,
      buffer,
      2,
      createOperationId,
      validateOperationId
    );

    expect(inFlight).toEqual({
      operationId: "I-operation-1",
      events: [{ id: 1 }, { id: 2 }]
    });

    buffer.push({ id: 3 });
    const retry = acquirePipelineBatch(inFlight, buffer, 2, createOperationId, validateOperationId);
    expect(retry).toBe(inFlight);
    expect(retry?.events).toEqual([{ id: 1 }, { id: 2 }]);

    acknowledgePipelineBatch(buffer, inFlight!);
    inFlight = null;
    expect(buffer).toEqual([{ id: 3 }]);

    const next = acquirePipelineBatch(inFlight, buffer, 2, createOperationId, validateOperationId);
    expect(next).toEqual({ operationId: "I-operation-2", events: [{ id: 3 }] });
  });

  it("fails closed if the buffered prefix changes before acknowledgement", () => {
    const original = { id: 1 };
    const buffer = [original];
    const batch = acquirePipelineBatch(null, buffer, 1, () => "I-one", String)!;
    buffer[0] = { id: 1 };

    expect(() => acknowledgePipelineBatch(buffer, batch)).toThrow(
      "changed before the in-flight batch was acknowledged"
    );
  });

  it("retries ingest timeouts without retrying timeouts for other side effects", () => {
    const timeout = new Error("Timed out waiting for offscreen response: ingestBatch");

    expect(shouldRetryOffscreenPipelineRequest("ingest", timeout)).toBe(true);
    expect(shouldRetryOffscreenPipelineRequest("ingestBatch", timeout)).toBe(true);
    expect(shouldRetryOffscreenPipelineRequest("ingestBatchDurably", timeout)).toBe(true);
    expect(shouldRetryOffscreenPipelineRequest("ingestBatchWithDelivery", timeout)).toBe(true);
    expect(shouldRetryOffscreenPipelineRequest("commitDeliveryProgress", timeout)).toBe(true);
    expect(shouldRetryOffscreenPipelineRequest("getDeliveryReceipt", timeout)).toBe(true);
    expect(shouldRetryOffscreenPipelineRequest("putBlob", timeout)).toBe(false);
    expect(shouldRetryOffscreenPipelineRequest("exportDownload", timeout)).toBe(false);
    expect(shouldRetryOffscreenPipelineRequest("close", timeout)).toBe(false);
  });

  it("does not replay an export after a disconnect with an unknown result", () => {
    const disconnected = new Error("Offscreen pipeline disconnected.");
    const unavailable = new Error("Offscreen pipeline is unavailable.");
    const missingSession = new Error("Pipeline session not found: session-1");
    const replaySafeAfterDisconnect = [
      "ingest",
      "ingestBatch",
      "ingestBatchDurably",
      "ingestBatchWithDelivery",
      "commitDeliveryProgress",
      "flush",
      "getResumeState",
      "getDeliveryReceipt",
      "putBlob",
      "close",
      "getScreenRecordingStatus",
      "startScreenRecording",
      "stopScreenRecording"
    ] as const;

    for (const op of replaySafeAfterDisconnect) {
      expect(shouldRetryOffscreenPipelineRequest(op, disconnected)).toBe(true);
    }

    expect(shouldRetryOffscreenPipelineRequest("exportDownload", disconnected)).toBe(false);
    expect(shouldRetryOffscreenPipelineRequest("exportDownload", unavailable)).toBe(true);
    expect(shouldRetryOffscreenPipelineRequest("exportDownload", missingSession)).toBe(true);
    expect(shouldRetryOffscreenPipelineRequest("start", disconnected)).toBe(false);
    expect(shouldRetryOffscreenPipelineRequest("start", unavailable)).toBe(false);
    expect(shouldRetryOffscreenPipelineRequest("start", missingSession)).toBe(false);
  });
});
