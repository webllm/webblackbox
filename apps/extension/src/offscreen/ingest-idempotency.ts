const SESSION_ID_PATTERN = /^S-[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
const OPERATION_ID_PATTERN = /^I-[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
const EVENT_ID_PATTERN = /^E-([0-9]{1,16})$/;

export const INGEST_IDEMPOTENCY_DEFAULT_TTL_MS = 5 * 60_000;
export const INGEST_IDEMPOTENCY_DEFAULT_MAX_ENTRIES = 2_048;
export const INGEST_IDEMPOTENCY_MAX_SESSION_ID_LENGTH = 128;
export const INGEST_IDEMPOTENCY_MAX_OPERATION_ID_LENGTH = 128;

export type IngestOperation =
  | "ingest"
  | "ingestBatch"
  | "ingestBatchDurably"
  | "ingestBatchWithDelivery";

export type IngestOperationFingerprint = Readonly<{
  op: IngestOperation;
  count: number;
  firstId: string;
  lastId: string;
  deliveryFingerprint?: string;
}>;

export type IngestIdempotencyOperation = Readonly<{
  sid: string;
  operationId: string;
  fingerprint: IngestOperationFingerprint;
}>;

export type IngestIdempotencyRegistryOptions = Readonly<{
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}>;

type InFlightEntry = {
  state: "in-flight";
  sid: string;
  fingerprint: string;
  promise: Promise<void>;
};

type CompletedEntry = {
  state: "completed";
  sid: string;
  fingerprint: string;
  expiresAt: number;
};

type IdempotencyEntry = InFlightEntry | CompletedEntry;

type EventWithId = Readonly<{ id: string }>;

export type SequenceAwareIngestPipeline<TEvent extends EventWithId> = Readonly<{
  getSequenceWatermark: () => Promise<Readonly<{ event: number }>>;
  ingest: (event: TEvent) => Promise<void>;
  ingestBatch: (events: TEvent[]) => Promise<void>;
  ingestBatchWithDelivery?: (
    events: TEvent[],
    deliveryByEventId: PipelineDeliverySidecar
  ) => Promise<void>;
  flush: () => Promise<void>;
}>;

export type ExecuteIngestOperationOptions<TEvent extends EventWithId> = Readonly<{
  sid: string;
  op: IngestOperation;
  operationId?: unknown;
  events: readonly TEvent[];
  deliveryByEventId?: PipelineDeliverySidecar;
  pipeline: SequenceAwareIngestPipeline<TEvent>;
  registry: IngestIdempotencyRegistry;
}>;

/**
 * Bounds duplicate ingest work across lost offscreen responses and reconnect retries.
 * Completed operations are retained briefly; in-flight operations are never evicted.
 */
export class IngestIdempotencyRegistry {
  private readonly entries = new Map<string, IdempotencyEntry>();

  private readonly ttlMs: number;

  private readonly maxEntries: number;

  private readonly now: () => number;

  public constructor(options: IngestIdempotencyRegistryOptions = {}) {
    this.ttlMs = requirePositiveSafeInteger(
      options.ttlMs ?? INGEST_IDEMPOTENCY_DEFAULT_TTL_MS,
      "Ingest idempotency TTL"
    );
    this.maxEntries = requirePositiveSafeInteger(
      options.maxEntries ?? INGEST_IDEMPOTENCY_DEFAULT_MAX_ENTRIES,
      "Ingest idempotency entry limit"
    );
    this.now = options.now ?? Date.now;
  }

  public execute(operation: IngestIdempotencyOperation, task: () => Promise<void>): Promise<void> {
    assertSessionId(operation.sid);
    assertOperationId(operation.operationId);
    const fingerprint = serializeFingerprint(operation.fingerprint);
    const key = serializeOperationKey(operation.sid, operation.operationId);
    const now = this.readNow();

    this.pruneExpired(now);

    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(
          new Error("Ingest idempotency key was reused with a different fingerprint.")
        );
      }

      return existing.state === "in-flight" ? existing.promise : Promise.resolve();
    }

    if (!this.makeCapacity()) {
      return Promise.reject(
        new Error("Ingest idempotency registry is full of in-flight operations.")
      );
    }

    const entry: InFlightEntry = {
      state: "in-flight",
      sid: operation.sid,
      fingerprint,
      promise: Promise.resolve()
    };
    const promise = Promise.resolve()
      .then(task)
      .then(
        () => {
          if (this.entries.get(key) !== entry) {
            return;
          }

          this.entries.set(key, {
            state: "completed",
            sid: operation.sid,
            fingerprint,
            expiresAt: this.readNow() + this.ttlMs
          });
        },
        (error: unknown) => {
          if (this.entries.get(key) === entry) {
            this.entries.delete(key);
          }

          throw error;
        }
      );
    entry.promise = promise;
    this.entries.set(key, entry);
    return promise;
  }

  public clearSession(sid: string): void {
    assertSessionId(sid);

    for (const [key, entry] of this.entries) {
      if (entry.sid === sid) {
        this.entries.delete(key);
      }
    }
  }

  private makeCapacity(): boolean {
    while (this.entries.size >= this.maxEntries) {
      const completedKey = [...this.entries].find(([, entry]) => entry.state === "completed")?.[0];

      if (!completedKey) {
        return false;
      }

      this.entries.delete(completedKey);
    }

    return true;
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.state === "completed" && entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  private readNow(): number {
    const value = this.now();

    if (!Number.isFinite(value)) {
      throw new Error("Ingest idempotency clock must return a finite number.");
    }

    return value;
  }
}

/**
 * Runs an ingest request against only the suffix not represented by durable pipeline state.
 * The optional operation id additionally coalesces concurrent retries and caches their ack.
 */
export async function executeIngestOperation<TEvent extends EventWithId>(
  options: ExecuteIngestOperationOptions<TEvent>
): Promise<void> {
  const operationId = normalizeOptionalIngestOperationId(options.operationId);
  const fingerprint = createIngestOperationFingerprint(
    options.op,
    options.events,
    options.deliveryByEventId
  );
  const task = async (): Promise<void> => {
    const watermark = await options.pipeline.getSequenceWatermark();
    const suffix = selectContiguousIngestSuffix(options.events, watermark.event);

    if (
      suffix.length === 0 &&
      options.op !== "ingestBatchDurably" &&
      options.op !== "ingestBatchWithDelivery"
    ) {
      return;
    }

    if (options.op === "ingest") {
      await options.pipeline.ingest(suffix[0]!);
      return;
    }

    if (suffix.length > 0 && options.op === "ingestBatchWithDelivery") {
      if (!options.pipeline.ingestBatchWithDelivery) {
        throw new Error("Pipeline does not support delivery-aware ingest.");
      }
      await options.pipeline.ingestBatchWithDelivery(
        suffix,
        selectDeliverySidecar(options.deliveryByEventId!, suffix)
      );
    } else if (suffix.length > 0) {
      await options.pipeline.ingestBatch(suffix);
    }
    if (options.op === "ingestBatchDurably" || options.op === "ingestBatchWithDelivery") {
      await options.pipeline.flush();
    }
  };

  if (operationId === undefined) {
    await task();
    return;
  }

  await options.registry.execute(
    {
      sid: options.sid,
      operationId,
      fingerprint
    },
    task
  );
}

export function normalizeOptionalIngestOperationId(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error("Invalid ingest idempotency operation id.");
  }

  assertOperationId(value);
  return value;
}

export function createIngestOperationFingerprint<TEvent extends EventWithId>(
  op: IngestOperation,
  events: readonly TEvent[],
  deliveryByEventId?: PipelineDeliverySidecar
): IngestOperationFingerprint {
  const sequences = parseStrictlyContiguousSequences(events);

  if (op === "ingest" && events.length !== 1) {
    throw new Error("A single ingest operation must contain exactly one event.");
  }

  const deliveryFingerprint = serializeDeliverySidecar(op, events, deliveryByEventId);

  return {
    op,
    count: events.length,
    firstId: events[0]!.id,
    lastId: events[sequences.length - 1]!.id,
    ...(deliveryFingerprint === undefined ? {} : { deliveryFingerprint })
  };
}

/**
 * Validates a retry batch and selects only events newer than the pipeline watermark.
 * A batch may begin above the watermark because a durable recorder counter can outlive
 * an unflushed service-worker buffer; only ordering inside the retry batch must be contiguous.
 */
export function selectContiguousIngestSuffix<TEvent extends EventWithId>(
  events: readonly TEvent[],
  watermark: number
): TEvent[] {
  if (!Number.isSafeInteger(watermark) || watermark < 0) {
    throw new Error("Pipeline event sequence watermark must be a non-negative safe integer.");
  }

  const sequences = parseStrictlyContiguousSequences(events);
  const suffixIndex = sequences.findIndex((sequence) => sequence > watermark);

  if (suffixIndex === -1) {
    return [];
  }

  return events.slice(suffixIndex);
}

function parseStrictlyContiguousSequences<TEvent extends EventWithId>(
  events: readonly TEvent[]
): number[] {
  if (events.length === 0) {
    throw new Error("Ingest operation must contain at least one event.");
  }

  const sequences = events.map((event) => parseCanonicalEventSequence(event.id));

  for (let index = 1; index < sequences.length; index += 1) {
    if (sequences[index] !== sequences[index - 1]! + 1) {
      throw new Error("Ingest event ids must form a strictly increasing contiguous sequence.");
    }
  }

  return sequences;
}

function parseCanonicalEventSequence(eventId: string): number {
  const match = EVENT_ID_PATTERN.exec(eventId);
  const sequence = match?.[1] ? Number(match[1]) : Number.NaN;

  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error(`Invalid canonical ingest event id: ${eventId}`);
  }

  return sequence;
}

function serializeFingerprint(fingerprint: IngestOperationFingerprint): string {
  if (
    fingerprint.op !== "ingest" &&
    fingerprint.op !== "ingestBatch" &&
    fingerprint.op !== "ingestBatchDurably" &&
    fingerprint.op !== "ingestBatchWithDelivery"
  ) {
    throw new Error("Invalid ingest operation fingerprint type.");
  }

  const firstSequence = parseCanonicalEventSequence(fingerprint.firstId);
  const lastSequence = parseCanonicalEventSequence(fingerprint.lastId);

  if (!Number.isSafeInteger(fingerprint.count) || fingerprint.count <= 0) {
    throw new Error("Ingest operation fingerprint count must be a positive safe integer.");
  }

  if (lastSequence - firstSequence + 1 !== fingerprint.count) {
    throw new Error("Ingest operation fingerprint ids do not match its event count.");
  }

  if (fingerprint.op === "ingest" && fingerprint.count !== 1) {
    throw new Error("A single ingest fingerprint must describe exactly one event.");
  }

  if (
    fingerprint.op === "ingestBatchWithDelivery" &&
    (typeof fingerprint.deliveryFingerprint !== "string" ||
      fingerprint.deliveryFingerprint.length === 0)
  ) {
    throw new Error("A delivery-aware ingest fingerprint must include its sidecar.");
  }
  if (
    fingerprint.op !== "ingestBatchWithDelivery" &&
    fingerprint.deliveryFingerprint !== undefined
  ) {
    throw new Error("A non-delivery ingest fingerprint cannot include a delivery sidecar.");
  }

  return JSON.stringify([
    fingerprint.op,
    fingerprint.count,
    fingerprint.firstId,
    fingerprint.lastId,
    fingerprint.deliveryFingerprint ?? null
  ]);
}

function serializeDeliverySidecar<TEvent extends EventWithId>(
  op: IngestOperation,
  events: readonly TEvent[],
  deliveryByEventId: PipelineDeliverySidecar | undefined
): string | undefined {
  if (op !== "ingestBatchWithDelivery") {
    if (deliveryByEventId && deliveryByEventId.size > 0) {
      throw new Error("A non-delivery ingest operation cannot include a delivery sidecar.");
    }
    return undefined;
  }

  if (!deliveryByEventId || deliveryByEventId.size === 0) {
    throw new Error("A delivery-aware ingest operation requires a delivery sidecar.");
  }

  const eventIds = new Set(events.map((event) => event.id));
  for (const eventId of deliveryByEventId.keys()) {
    if (!eventIds.has(eventId)) {
      throw new Error("Delivery sidecar references an event outside its ingest batch.");
    }
  }

  return JSON.stringify(
    events.map((event) => {
      const provenance = deliveryByEventId.get(event.id);
      return provenance ? serializeDeliveryProvenance(event.id, provenance) : null;
    })
  );
}

function serializeDeliveryProvenance(
  eventId: string,
  provenance: PipelineDeliveryEventProvenance
): readonly unknown[] {
  return [
    eventId,
    provenance.tabId,
    provenance.frameId,
    provenance.documentId,
    provenance.batchId,
    provenance.fingerprint,
    provenance.eventCount,
    provenance.eventIndex
  ];
}

function selectDeliverySidecar<TEvent extends EventWithId>(
  deliveryByEventId: PipelineDeliverySidecar,
  events: readonly TEvent[]
): PipelineDeliverySidecar {
  const selected = new Map<string, PipelineDeliveryEventProvenance>();
  for (const event of events) {
    const provenance = deliveryByEventId.get(event.id);
    if (provenance) {
      selected.set(event.id, provenance);
    }
  }
  return selected;
}

function serializeOperationKey(sid: string, operationId: string): string {
  return JSON.stringify([sid, operationId]);
}

function assertSessionId(sid: string): void {
  if (sid.length > INGEST_IDEMPOTENCY_MAX_SESSION_ID_LENGTH || !SESSION_ID_PATTERN.test(sid)) {
    throw new Error("Invalid ingest idempotency session id.");
  }
}

function assertOperationId(operationId: string): void {
  if (
    operationId.length > INGEST_IDEMPOTENCY_MAX_OPERATION_ID_LENGTH ||
    !OPERATION_ID_PATTERN.test(operationId)
  ) {
    throw new Error("Invalid ingest idempotency operation id.");
  }
}

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }

  return value;
}
import type {
  PipelineDeliveryEventProvenance,
  PipelineDeliverySidecar
} from "@webblackbox/pipeline";
