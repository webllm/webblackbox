export const CONTENT_EVENT_BATCH_COMPLETED_LIMIT = 256;

export type ContentEventBatchRecord<Port extends object> = {
  status: "processing" | "retryable" | "completed";
  readonly fingerprint: string;
  readonly completedEventIndexes: Set<number>;
  readonly ackPorts: Set<Port>;
};

export type ContentEventBatchBeginResult<Port extends object> =
  | { kind: "process"; record: ContentEventBatchRecord<Port> }
  | { kind: "processing"; record: ContentEventBatchRecord<Port> }
  | { kind: "completed"; record: ContentEventBatchRecord<Port> }
  | { kind: "mismatch"; record: ContentEventBatchRecord<Port> };

export type ContentEventBatchAttemptFailure = Readonly<{
  eventIndex?: number;
  error: unknown;
}>;

export type ContentEventBatchAttemptResult = Readonly<{
  completed: boolean;
  failures: readonly ContentEventBatchAttemptFailure[];
}>;

export type ContentEventBatchReceiptDecision =
  | Readonly<{ kind: "missing"; committedEventIndexes: readonly number[] }>
  | Readonly<{ kind: "partial"; committedEventIndexes: readonly number[] }>
  | Readonly<{ kind: "complete"; committedEventIndexes: readonly number[] }>
  | Readonly<{ kind: "mismatch"; committedEventIndexes: readonly number[] }>;

export async function readContentEventBatchReceiptAfterBarrier<Receipt>(input: {
  flushPendingDelivery: () => void | Promise<void>;
  isOwnerCurrent: () => boolean;
  readReceipt: () => Receipt | Promise<Receipt>;
}): Promise<Readonly<{ kind: "stale" }> | Readonly<{ kind: "current"; receipt: Receipt }>> {
  await input.flushPendingDelivery();
  if (!input.isOwnerCurrent()) {
    return { kind: "stale" };
  }

  const receipt = await input.readReceipt();
  return input.isOwnerCurrent() ? { kind: "current", receipt } : { kind: "stale" };
}

export function classifyContentEventBatchReceipt(
  receipt: PipelineDeliveryReceipt | undefined,
  expected: Readonly<{
    tabId: number;
    frameId: number;
    documentId: string;
    batchId: string;
    fingerprint: string;
    eventCount: number;
  }>
): ContentEventBatchReceiptDecision {
  if (!receipt) {
    return { kind: "missing", committedEventIndexes: [] };
  }

  const committedEventIndexes = receipt.indexes.map((index) => index.eventIndex);
  if (
    receipt.tabId !== expected.tabId ||
    receipt.frameId !== expected.frameId ||
    receipt.documentId !== expected.documentId ||
    receipt.batchId !== expected.batchId ||
    receipt.fingerprint !== expected.fingerprint ||
    receipt.eventCount !== expected.eventCount ||
    committedEventIndexes.some(
      (eventIndex) =>
        !Number.isSafeInteger(eventIndex) || eventIndex < 0 || eventIndex >= expected.eventCount
    ) ||
    new Set(committedEventIndexes).size !== committedEventIndexes.length ||
    receipt.complete !== (committedEventIndexes.length === expected.eventCount)
  ) {
    return { kind: "mismatch", committedEventIndexes: [] };
  }

  return {
    kind: receipt.complete ? "complete" : "partial",
    committedEventIndexes
  };
}

export type ContentEventBatchAdmissionIdentity<
  Runtime extends object,
  Fence extends object,
  Mode extends string
> = Readonly<{
  valid: boolean;
  runtime: Runtime;
  fence: Fence;
  activationId: string;
  batchId: string;
  sid: string;
  tabId: number;
  frameId: number;
  documentId: string;
  documentUrl: string;
  mode: Mode;
}>;

export type ContentEventBatchActivationIdentity<
  Runtime extends object,
  Fence extends object,
  Mode extends string
> = Readonly<{
  runtime: Runtime;
  fence: Fence;
  activationId: string;
  sid: string;
  tabId: number;
  frameId: number;
  documentId: string;
  url: string;
  mode: Mode;
}>;

/** Revalidates the exact live activation at every asynchronous admission point. */
export function isContentEventBatchAdmissionLive<
  Runtime extends object,
  Fence extends object,
  Mode extends string
>(
  admission: ContentEventBatchAdmissionIdentity<Runtime, Fence, Mode>,
  runtime: Runtime,
  fence: Fence,
  lookupActivation: (
    activationId: string
  ) => ContentEventBatchActivationIdentity<Runtime, Fence, Mode> | null
): boolean {
  if (
    !admission.valid ||
    admission.runtime !== runtime ||
    admission.fence !== fence ||
    admission.activationId.length === 0 ||
    admission.batchId.length === 0
  ) {
    return false;
  }

  const activation = lookupActivation(admission.activationId);
  return Boolean(
    activation &&
    activation.runtime === runtime &&
    activation.fence === fence &&
    activation.activationId === admission.activationId &&
    activation.sid === admission.sid &&
    activation.tabId === admission.tabId &&
    activation.frameId === admission.frameId &&
    activation.documentId === admission.documentId &&
    activation.url === admission.documentUrl &&
    activation.mode === admission.mode
  );
}

/**
 * Keeps one retryable delivery ledger per exact activation. Event indexes are
 * retained across a failed attempt so a replay can finish the missing suffix
 * without ingesting already accepted records twice.
 */
export class ContentEventBatchLedger<Port extends object> {
  private readonly byActivation = new Map<string, Map<string, ContentEventBatchRecord<Port>>>();

  public begin(
    activationId: string,
    batchId: string,
    fingerprint: string,
    port: Port
  ): ContentEventBatchBeginResult<Port> {
    let batches = this.byActivation.get(activationId);

    if (!batches) {
      batches = new Map();
      this.byActivation.set(activationId, batches);
    }

    const existing = batches.get(batchId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return { kind: "mismatch", record: existing };
      }
      if (existing.status === "completed") {
        return { kind: "completed", record: existing };
      }

      existing.ackPorts.add(port);
      if (existing.status === "processing") {
        return { kind: "processing", record: existing };
      }

      existing.status = "processing";
      return { kind: "process", record: existing };
    }

    const record: ContentEventBatchRecord<Port> = {
      status: "processing",
      fingerprint,
      completedEventIndexes: new Set(),
      ackPorts: new Set([port])
    };
    batches.set(batchId, record);
    return { kind: "process", record };
  }

  public retry(
    activationId: string,
    batchId: string,
    record: ContentEventBatchRecord<Port>
  ): boolean {
    const current = this.byActivation.get(activationId)?.get(batchId);

    if (current !== record || record.status !== "processing") {
      return false;
    }

    record.status = "retryable";
    record.ackPorts.clear();
    return true;
  }

  public complete(
    activationId: string,
    batchId: string,
    record: ContentEventBatchRecord<Port>
  ): Port[] {
    const batches = this.byActivation.get(activationId);

    if (batches?.get(batchId) !== record || record.status !== "processing") {
      return [];
    }

    record.status = "completed";
    const ports = [...record.ackPorts];
    record.ackPorts.clear();
    let completedCount = [...batches.values()].filter(
      (candidate) => candidate.status === "completed"
    ).length;

    for (const [candidateId, candidate] of batches) {
      if (completedCount <= CONTENT_EVENT_BATCH_COMPLETED_LIMIT) {
        break;
      }
      if (candidate.status === "completed") {
        batches.delete(candidateId);
        completedCount -= 1;
      }
    }

    return ports;
  }

  public invalidate(activationId: string): void {
    this.byActivation.delete(activationId);
  }
}

/** Processes only missing indexes and requires the resulting pipeline buffer to
 * flush before the caller is allowed to complete and acknowledge the batch. */
export async function processContentEventBatchAttempt<Port extends object>(input: {
  record: ContentEventBatchRecord<Port>;
  eventCount: number;
  processEvent: (eventIndex: number) => void | Promise<void>;
  flush: () => void | Promise<void>;
}): Promise<ContentEventBatchAttemptResult> {
  const failures: ContentEventBatchAttemptFailure[] = [];

  for (let eventIndex = 0; eventIndex < input.eventCount; eventIndex += 1) {
    if (input.record.completedEventIndexes.has(eventIndex)) {
      continue;
    }

    try {
      await input.processEvent(eventIndex);
      input.record.completedEventIndexes.add(eventIndex);
    } catch (error) {
      failures.push({ eventIndex, error });
    }
  }

  if (failures.length === 0 && input.record.completedEventIndexes.size === input.eventCount) {
    try {
      await input.flush();
    } catch (error) {
      failures.push({ error });
    }
  }

  return {
    completed:
      failures.length === 0 && input.record.completedEventIndexes.size === input.eventCount,
    failures
  };
}

export async function fingerprintContentEventBatch(events: readonly unknown[]): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("SHA-256 is unavailable for content event batch fingerprinting.");
  }

  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalizeContentEventBatchValue(events))
  );
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function canonicalizeContentEventBatchValue(value: unknown): string {
  if (value === undefined) {
    return "u";
  }
  if (value === null) {
    return "n";
  }
  if (typeof value === "boolean") {
    return value ? "b1" : "b0";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Content event batch fingerprint cannot encode a non-finite number.");
    }
    return `d${Object.is(value, -0) ? "-0" : String(value)};`;
  }
  if (typeof value === "string") {
    return `s${JSON.stringify(value)};`;
  }
  if (Array.isArray(value)) {
    return `a${value.length}[${value.map(canonicalizeContentEventBatchValue).join("")}]`;
  }
  if (typeof value !== "object") {
    throw new Error("Content event batch fingerprint encountered an unsupported value.");
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return `o${keys.length}{${keys
    .map(
      (key) =>
        `${canonicalizeContentEventBatchValue(key)}${canonicalizeContentEventBatchValue(record[key])}`
    )
    .join("")}}`;
}
import type { PipelineDeliveryReceipt } from "@webblackbox/pipeline";
