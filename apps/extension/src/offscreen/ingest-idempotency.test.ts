import { describe, expect, it, vi } from "vitest";

import {
  INGEST_IDEMPOTENCY_MAX_OPERATION_ID_LENGTH,
  INGEST_IDEMPOTENCY_MAX_SESSION_ID_LENGTH,
  IngestIdempotencyRegistry,
  createIngestOperationFingerprint,
  executeIngestOperation,
  normalizeOptionalIngestOperationId,
  selectContiguousIngestSuffix,
  type IngestIdempotencyOperation,
  type IngestOperationFingerprint
} from "./ingest-idempotency.js";

type TestEvent = { id: string; value?: string };

const SINGLE_FINGERPRINT: IngestOperationFingerprint = {
  op: "ingest",
  count: 1,
  firstId: "E-00000001",
  lastId: "E-00000001"
};

function operation(
  operationId: string,
  fingerprint: IngestOperationFingerprint = SINGLE_FINGERPRINT,
  sid = "S-session-1"
): IngestIdempotencyOperation {
  return { sid, operationId, fingerprint };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("IngestIdempotencyRegistry", () => {
  it("joins concurrent retries and acknowledges a completed operation during its TTL", async () => {
    let now = 1_000;
    const pending = deferred();
    const task = vi.fn(() => pending.promise);
    const registry = new IngestIdempotencyRegistry({ ttlMs: 100, now: () => now });
    const first = registry.execute(operation("I-operation-1"), task);
    const concurrentRetry = registry.execute(operation("I-operation-1"), task);

    expect(concurrentRetry).toBe(first);
    expect(task).toHaveBeenCalledTimes(0);
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);

    pending.resolve();
    await expect(Promise.all([first, concurrentRetry])).resolves.toEqual([undefined, undefined]);
    await expect(registry.execute(operation("I-operation-1"), task)).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledTimes(1);

    now += 101;
    await registry.execute(operation("I-operation-1"), task);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("removes failed operations so the same key can be retried", async () => {
    const registry = new IngestIdempotencyRegistry();
    const failure = new Error("commit failed");
    const task = vi.fn<() => Promise<void>>().mockRejectedValueOnce(failure).mockResolvedValue();

    await expect(registry.execute(operation("I-retryable"), task)).rejects.toBe(failure);
    await expect(registry.execute(operation("I-retryable"), task)).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("fails closed when an in-flight or completed key is reused with another fingerprint", async () => {
    const pending = deferred();
    const registry = new IngestIdempotencyRegistry();
    const original = registry.execute(operation("I-collision"), () => pending.promise);
    const different: IngestOperationFingerprint = {
      op: "ingestBatch",
      count: 2,
      firstId: "E-00000001",
      lastId: "E-00000002"
    };

    await expect(
      registry.execute(operation("I-collision", different), async () => undefined)
    ).rejects.toThrow("different fingerprint");
    pending.resolve();
    await original;
    await expect(
      registry.execute(operation("I-collision", different), async () => undefined)
    ).rejects.toThrow("different fingerprint");
  });

  it("evicts completed operations but never in-flight work at its global limit", async () => {
    const registry = new IngestIdempotencyRegistry({ maxEntries: 2 });
    await registry.execute(operation("I-completed"), async () => undefined);
    const second = deferred();
    const third = deferred();
    const secondPromise = registry.execute(operation("I-second"), () => second.promise);
    const thirdPromise = registry.execute(operation("I-third"), () => third.promise);
    const rejectedTask = vi.fn(async () => undefined);

    await expect(registry.execute(operation("I-fourth"), rejectedTask)).rejects.toThrow(
      "full of in-flight operations"
    );
    expect(rejectedTask).not.toHaveBeenCalled();
    expect(registry.execute(operation("I-second"), () => Promise.resolve())).toBe(secondPromise);

    second.resolve();
    third.resolve();
    await Promise.all([secondPromise, thirdPromise]);
  });

  it("clears only the requested session, including its in-flight entries", async () => {
    const registry = new IngestIdempotencyRegistry();
    const abandoned = deferred();
    const original = registry.execute(
      operation("I-same", SINGLE_FINGERPRINT, "S-one"),
      () => abandoned.promise
    );
    const retainedTask = vi.fn(async () => undefined);
    await registry.execute(operation("I-same", SINGLE_FINGERPRINT, "S-two"), retainedTask);

    registry.clearSession("S-one");
    const replacementTask = vi.fn(async () => undefined);
    await registry.execute(operation("I-same", SINGLE_FINGERPRINT, "S-one"), replacementTask);
    await registry.execute(operation("I-same", SINGLE_FINGERPRINT, "S-two"), retainedTask);

    expect(replacementTask).toHaveBeenCalledTimes(1);
    expect(retainedTask).toHaveBeenCalledTimes(1);
    abandoned.resolve();
    await original;
  });

  it("enforces bounded, unambiguous session and operation ids", async () => {
    const registry = new IngestIdempotencyRegistry();
    const task = vi.fn(async () => undefined);

    expect(() => registry.execute(operation("I-invalid|delimiter"), task)).toThrow(
      "Invalid ingest idempotency operation id"
    );
    expect(() =>
      registry.execute(
        operation(`I-${"a".repeat(INGEST_IDEMPOTENCY_MAX_OPERATION_ID_LENGTH)}`),
        task
      )
    ).toThrow("Invalid ingest idempotency operation id");
    expect(() =>
      registry.execute(
        operation(
          "I-valid",
          SINGLE_FINGERPRINT,
          `S-${"a".repeat(INGEST_IDEMPOTENCY_MAX_SESSION_ID_LENGTH)}`
        ),
        task
      )
    ).toThrow("Invalid ingest idempotency session id");
    expect(task).not.toHaveBeenCalled();
  });

  it("rejects invalid constructor bounds and a non-finite clock", () => {
    expect(() => new IngestIdempotencyRegistry({ maxEntries: 0 })).toThrow(
      "entry limit must be a positive safe integer"
    );
    expect(() => new IngestIdempotencyRegistry({ ttlMs: Number.NaN })).toThrow(
      "TTL must be a positive safe integer"
    );
    const registry = new IngestIdempotencyRegistry({ now: () => Number.POSITIVE_INFINITY });
    expect(() => registry.execute(operation("I-clock"), async () => undefined)).toThrow(
      "clock must return a finite number"
    );
  });
});

describe("createIngestOperationFingerprint", () => {
  it("includes operation, count, first id, and last id", () => {
    expect(
      createIngestOperationFingerprint("ingestBatch", [{ id: "E-00000009" }, { id: "E-00000010" }])
    ).toEqual({
      op: "ingestBatch",
      count: 2,
      firstId: "E-00000009",
      lastId: "E-00000010"
    });
  });

  it("requires exactly one event for a single ingest operation", () => {
    expect(() =>
      createIngestOperationFingerprint("ingest", [{ id: "E-00000001" }, { id: "E-00000002" }])
    ).toThrow("exactly one event");
  });
});

describe("selectContiguousIngestSuffix", () => {
  const events: TestEvent[] = [
    { id: "E-00000001", value: "one" },
    { id: "E-00000002", value: "two" },
    { id: "E-00000003", value: "three" },
    { id: "E-00000004", value: "four" }
  ];

  it("returns the full batch when no event is durable", () => {
    expect(selectContiguousIngestSuffix(events, 0)).toEqual(events);
  });

  it("returns a contiguous suffix after a partially durable batch", () => {
    expect(selectContiguousIngestSuffix(events, 2)).toEqual(events.slice(2));
  });

  it("returns an empty suffix when every event was already accepted", () => {
    expect(selectContiguousIngestSuffix(events, 4)).toEqual([]);
    expect(selectContiguousIngestSuffix(events, 10)).toEqual([]);
  });

  it("rejects non-canonical or unsafe event ids", () => {
    expect(() => selectContiguousIngestSuffix([{ id: "event-1" }], 0)).toThrow(
      "Invalid canonical ingest event id"
    );
    expect(() => selectContiguousIngestSuffix([{ id: "E-9999999999999999" }], 0)).toThrow(
      "Invalid canonical ingest event id"
    );
  });

  it("rejects gaps in a batch", () => {
    expect(() =>
      selectContiguousIngestSuffix([{ id: "E-00000001" }, { id: "E-00000003" }], 0)
    ).toThrow("strictly increasing contiguous sequence");
  });

  it("rejects duplicate and descending event ids", () => {
    expect(() =>
      selectContiguousIngestSuffix([{ id: "E-00000002" }, { id: "E-00000002" }], 1)
    ).toThrow("strictly increasing contiguous sequence");
    expect(() =>
      selectContiguousIngestSuffix([{ id: "E-00000002" }, { id: "E-00000001" }], 0)
    ).toThrow("strictly increasing contiguous sequence");
  });

  it("accepts a new batch after an intentional recorder sequence gap", () => {
    expect(selectContiguousIngestSuffix([{ id: "E-00000003" }, { id: "E-00000004" }], 1)).toEqual([
      { id: "E-00000003" },
      { id: "E-00000004" }
    ]);
  });

  it("rejects an empty batch and invalid watermark", () => {
    expect(() => selectContiguousIngestSuffix([], 0)).toThrow("at least one event");
    expect(() => selectContiguousIngestSuffix(events, -1)).toThrow(
      "watermark must be a non-negative safe integer"
    );
  });
});

describe("executeIngestOperation", () => {
  function createPipeline(watermark: number) {
    return {
      getSequenceWatermark: vi.fn(async () => ({ event: watermark })),
      ingest: vi.fn<(event: TestEvent) => Promise<void>>(async () => undefined),
      ingestBatch: vi.fn<(events: TestEvent[]) => Promise<void>>(async () => undefined)
    };
  }

  const events: TestEvent[] = [
    { id: "E-00000001" },
    { id: "E-00000002" },
    { id: "E-00000003" },
    { id: "E-00000004" }
  ];

  it("executes the underlying ingest only once when the same operation response is lost", async () => {
    const registry = new IngestIdempotencyRegistry();
    const pipeline = createPipeline(0);
    const options = {
      sid: "S-session-1",
      op: "ingestBatch" as const,
      operationId: "I-response-lost",
      events,
      pipeline,
      registry
    };

    await executeIngestOperation(options);
    await executeIngestOperation(options);

    expect(pipeline.getSequenceWatermark).toHaveBeenCalledTimes(1);
    expect(pipeline.ingestBatch).toHaveBeenCalledTimes(1);
    expect(pipeline.ingestBatch).toHaveBeenCalledWith(events);
  });

  it("filters a partially durable batch after the registry cache is lost", async () => {
    const pipeline = createPipeline(2);

    await executeIngestOperation({
      sid: "S-session-1",
      op: "ingestBatch",
      operationId: "I-new-offscreen",
      events,
      pipeline,
      registry: new IngestIdempotencyRegistry()
    });

    expect(pipeline.ingestBatch).toHaveBeenCalledTimes(1);
    expect(pipeline.ingestBatch).toHaveBeenCalledWith(events.slice(2));
  });

  it("acknowledges a fully durable replay without ingesting it again", async () => {
    const pipeline = createPipeline(4);

    await executeIngestOperation({
      sid: "S-session-1",
      op: "ingestBatch",
      operationId: "I-full-replay",
      events,
      pipeline,
      registry: new IngestIdempotencyRegistry()
    });

    expect(pipeline.ingestBatch).not.toHaveBeenCalled();
    expect(pipeline.ingest).not.toHaveBeenCalled();
  });

  it("uses durable watermark filtering for legacy requests without an operation id", async () => {
    const pipeline = createPipeline(3);

    await executeIngestOperation({
      sid: "S-session-1",
      op: "ingestBatch",
      events,
      pipeline,
      registry: new IngestIdempotencyRegistry()
    });

    expect(pipeline.ingestBatch).toHaveBeenCalledWith(events.slice(3));
  });

  it("preserves single-event ingest behavior", async () => {
    const pipeline = createPipeline(0);

    await executeIngestOperation({
      sid: "S-session-1",
      op: "ingest",
      operationId: "I-single",
      events: events.slice(0, 1),
      pipeline,
      registry: new IngestIdempotencyRegistry()
    });

    expect(pipeline.ingest).toHaveBeenCalledWith(events[0]);
    expect(pipeline.ingestBatch).not.toHaveBeenCalled();
  });
});

describe("normalizeOptionalIngestOperationId", () => {
  it("accepts an absent or canonical operation id", () => {
    expect(normalizeOptionalIngestOperationId(undefined)).toBeUndefined();
    expect(normalizeOptionalIngestOperationId("I-operation-1")).toBe("I-operation-1");
  });

  it("rejects malformed and non-string operation ids", () => {
    expect(() => normalizeOptionalIngestOperationId(null)).toThrow(
      "Invalid ingest idempotency operation id"
    );
    expect(() => normalizeOptionalIngestOperationId("operation-1")).toThrow(
      "Invalid ingest idempotency operation id"
    );
  });
});
