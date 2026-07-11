import { describe, expect, it, vi } from "vitest";

import {
  CONTENT_EVENT_BATCH_COMPLETED_LIMIT,
  ContentEventBatchLedger,
  classifyContentEventBatchReceipt,
  fingerprintContentEventBatch,
  isContentEventBatchAdmissionLive,
  processContentEventBatchAttempt,
  readContentEventBatchReceiptAfterBarrier
} from "./content-event-batch-ledger.js";

describe("content event batch ledger", () => {
  it("retries only missing indexes after a processing failure", () => {
    const ledger = new ContentEventBatchLedger<object>();
    const firstPort = {};
    const first = ledger.begin("activation", "batch", "payload", firstPort);
    expect(first.kind).toBe("process");
    if (first.kind !== "process") {
      return;
    }

    first.record.completedEventIndexes.add(0);
    expect(ledger.retry("activation", "batch", first.record)).toBe(true);

    const retryPort = {};
    const retry = ledger.begin("activation", "batch", "payload", retryPort);
    expect(retry.kind).toBe("process");
    if (retry.kind !== "process") {
      return;
    }
    expect(retry.record).toBe(first.record);
    expect(retry.record.completedEventIndexes).toEqual(new Set([0]));
    retry.record.completedEventIndexes.add(1);
    expect(ledger.complete("activation", "batch", retry.record)).toEqual([retryPort]);
    expect(ledger.begin("activation", "batch", "payload", {}).kind).toBe("completed");
  });

  it("coalesces concurrent duplicates and rejects changed payloads", () => {
    const ledger = new ContentEventBatchLedger<object>();
    const first = ledger.begin("activation", "batch", "payload-a", {});
    expect(first.kind).toBe("process");
    expect(ledger.begin("activation", "batch", "payload-a", {}).kind).toBe("processing");
    expect(ledger.begin("activation", "batch", "payload-b", {}).kind).toBe("mismatch");
  });

  it("bounds completed tombstones per activation", () => {
    const ledger = new ContentEventBatchLedger<object>();

    for (let index = 0; index <= CONTENT_EVENT_BATCH_COMPLETED_LIMIT; index += 1) {
      const batchId = `batch-${index}`;
      const result = ledger.begin("activation", batchId, batchId, {});
      expect(result.kind).toBe("process");
      if (result.kind === "process") {
        ledger.complete("activation", batchId, result.record);
      }
    }

    expect(ledger.begin("activation", "batch-0", "batch-0", {}).kind).toBe("process");
    expect(
      ledger.begin(
        "activation",
        `batch-${CONTENT_EVENT_BATCH_COMPLETED_LIMIT}`,
        `batch-${CONTENT_EVENT_BATCH_COMPLETED_LIMIT}`,
        {}
      ).kind
    ).toBe("completed");
  });

  it("fingerprints canonical event content and order with SHA-256", async () => {
    const first = await fingerprintContentEventBatch([{ t: 1, payload: { b: 2, a: 1 } }, { t: 2 }]);

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(
      await fingerprintContentEventBatch([{ payload: { a: 1, b: 2 }, t: 1 }, { t: 2 }])
    );
    expect(first).not.toBe(await fingerprintContentEventBatch([{ t: 2 }, { t: 1 }]));
    expect(first).not.toBe(await fingerprintContentEventBatch([{ t: 1 }]));
    expect(await fingerprintContentEventBatch([{ payload: { value: undefined } }])).not.toBe(
      await fingerprintContentEventBatch([{ payload: {} }])
    );
  });

  it("classifies durable receipts for direct ack, partial replay, and mismatch", () => {
    const expected = {
      tabId: 7,
      frameId: 2,
      documentId: "document-1",
      batchId: "batch-1",
      fingerprint: "a".repeat(64),
      eventCount: 2
    };
    const partial = {
      ...expected,
      indexes: [{ eventIndex: 0, outcome: "event" as const, eventId: "E-1" }],
      complete: false
    };

    expect(classifyContentEventBatchReceipt(undefined, expected)).toEqual({
      kind: "missing",
      committedEventIndexes: []
    });
    expect(classifyContentEventBatchReceipt(partial, expected)).toEqual({
      kind: "partial",
      committedEventIndexes: [0]
    });
    expect(
      classifyContentEventBatchReceipt(
        {
          ...partial,
          indexes: [...partial.indexes, { eventIndex: 1, outcome: "no-output" as const }],
          complete: true
        },
        expected
      )
    ).toEqual({ kind: "complete", committedEventIndexes: [0, 1] });
    expect(
      classifyContentEventBatchReceipt({ ...partial, fingerprint: "b".repeat(64) }, expected)
    ).toEqual({ kind: "mismatch", committedEventIndexes: [] });
  });

  it("flushes predecessor activation output before a replacement reads its receipt", async () => {
    const order: string[] = [];
    let durableReceipt: { complete: boolean } | undefined;
    const result = await readContentEventBatchReceiptAfterBarrier({
      flushPendingDelivery: async () => {
        order.push("flush-old-output");
        durableReceipt = { complete: true };
      },
      isOwnerCurrent: () => true,
      readReceipt: async () => {
        order.push("read-replacement-receipt");
        return durableReceipt;
      }
    });

    expect(order).toEqual(["flush-old-output", "read-replacement-receipt"]);
    expect(result).toEqual({ kind: "current", receipt: { complete: true } });
  });

  it("does not read or reuse a receipt after the replacement owner becomes stale", async () => {
    const readReceipt = vi.fn();
    expect(
      await readContentEventBatchReceiptAfterBarrier({
        flushPendingDelivery: () => undefined,
        isOwnerCurrent: () => false,
        readReceipt
      })
    ).toEqual({ kind: "stale" });
    expect(readReceipt).not.toHaveBeenCalled();
  });

  it("does not reprocess successful indexes after an event failure", async () => {
    const ledger = new ContentEventBatchLedger<object>();
    const begin = ledger.begin("activation", "batch", "payload", {});
    expect(begin.kind).toBe("process");
    if (begin.kind !== "process") {
      return;
    }
    let failSecond = true;
    const processed: number[] = [];
    const first = await processContentEventBatchAttempt({
      record: begin.record,
      eventCount: 2,
      processEvent: (index) => {
        processed.push(index);
        if (index === 1 && failSecond) {
          throw new Error("putBlob failed");
        }
      },
      flush: () => undefined
    });

    expect(first.completed).toBe(false);
    expect(first.failures).toHaveLength(1);
    expect(begin.record.completedEventIndexes).toEqual(new Set([0]));
    ledger.retry("activation", "batch", begin.record);
    const retry = ledger.begin("activation", "batch", "payload", {});
    expect(retry.kind).toBe("process");
    failSecond = false;
    if (retry.kind === "process") {
      expect(
        await processContentEventBatchAttempt({
          record: retry.record,
          eventCount: 2,
          processEvent: (index) => {
            processed.push(index);
          },
          flush: () => undefined
        })
      ).toMatchObject({ completed: true, failures: [] });
    }
    expect(processed).toEqual([0, 1, 1]);
  });

  it("withholds completion until a failed durable flush succeeds", async () => {
    const ledger = new ContentEventBatchLedger<object>();
    const begin = ledger.begin("activation", "batch", "payload", {});
    expect(begin.kind).toBe("process");
    if (begin.kind !== "process") {
      return;
    }
    let flushFails = true;
    const processEvent = vi.fn();
    const flush = vi.fn(() => {
      if (flushFails) {
        throw new Error("pipeline ingest failed");
      }
    });

    expect(
      await processContentEventBatchAttempt({
        record: begin.record,
        eventCount: 1,
        processEvent,
        flush
      })
    ).toMatchObject({ completed: false });
    expect(begin.record.completedEventIndexes).toEqual(new Set([0]));
    ledger.retry("activation", "batch", begin.record);
    const retry = ledger.begin("activation", "batch", "payload", {});
    flushFails = false;
    if (retry.kind === "process") {
      expect(
        await processContentEventBatchAttempt({
          record: retry.record,
          eventCount: 1,
          processEvent,
          flush
        })
      ).toMatchObject({ completed: true, failures: [] });
    }
    expect(processEvent).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("rejects an in-flight child batch after its parent revokes the activation tree", () => {
    const runtime = {};
    const fence = {};
    const admission = {
      valid: true,
      runtime,
      fence,
      activationId: "child-activation",
      batchId: "batch",
      sid: "S-tree",
      tabId: 7,
      frameId: 4,
      documentId: "child-document",
      documentUrl: "https://app.example/child",
      mode: "lite"
    } as const;
    let childActivation = {
      runtime,
      fence,
      activationId: admission.activationId,
      sid: admission.sid,
      tabId: admission.tabId,
      frameId: admission.frameId,
      documentId: admission.documentId,
      url: admission.documentUrl,
      mode: admission.mode
    } as {
      runtime: typeof runtime;
      fence: typeof fence;
      activationId: string;
      sid: string;
      tabId: number;
      frameId: number;
      documentId: string;
      url: string;
      mode: "lite";
    } | null;

    expect(isContentEventBatchAdmissionLive(admission, runtime, fence, () => childActivation)).toBe(
      true
    );

    childActivation = null;
    expect(isContentEventBatchAdmissionLive(admission, runtime, fence, () => childActivation)).toBe(
      false
    );
  });
});
