import type { PipelineResumeState } from "@webblackbox/pipeline";
import {
  evaluateCaptureScope,
  recorderConfigSchema,
  sanitizeUrlForPrivacy,
  type CaptureMode,
  type RecorderConfig
} from "@webblackbox/protocol";

export const RUNTIME_STATE_SCHEMA_VERSION = 1;
export const RUNTIME_CLEANUP_ALARM_PREFIX = "webblackbox.runtime.cleanup:";

const MAX_PERSISTED_SESSIONS = 512;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const MAX_SCREEN_RECORDING_CHUNKS = 500_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type PersistedRuntimeCounters = {
  recorderEventSequence: number;
  recorderActionSequence: number;
  eventCount: number;
  errorCount: number;
  sizeBytes: number;
  budgetAlertCount: number;
  droppedBestEffortTasks: number;
  responseBodyCaptures: number;
  networkTotal: number;
  networkFailed: number;
};

export type PersistedScreenRecording = {
  recordingId: string;
  startedAt: number;
  startedMono: number;
  mime: string;
  width?: number;
  height?: number;
  frameRate?: number;
  chunkCount: number;
  sizeBytes: number;
};

type PersistedRuntimeBase = {
  sid: string;
  tabId: number;
  mode: CaptureMode;
  url: string;
  title?: string;
  tags: string[];
  note?: string;
  config: RecorderConfig;
  startedAt: number;
  counters: PersistedRuntimeCounters;
  screenRecording?: PersistedScreenRecording;
};

export type PersistedActiveRuntime = PersistedRuntimeBase & {
  state: "active";
};

export type PersistedStoppingRuntime = PersistedRuntimeBase & {
  state: "stopping";
  stopRequestedAt: number;
  cleanupDeadline: number;
};

export type PersistedStoppedRuntime = PersistedRuntimeBase & {
  state: "stopped";
  stoppedAt: number;
  cleanupDeadline: number;
};

export type PersistedRuntime =
  | PersistedActiveRuntime
  | PersistedStoppingRuntime
  | PersistedStoppedRuntime;

export type RuntimeStateSnapshot = {
  schemaVersion: typeof RUNTIME_STATE_SCHEMA_VERSION;
  savedAt: number;
  sessions: PersistedRuntime[];
};

export type ActiveRuntimeRestorationDecision =
  | { allowed: true; captureUrl: string; sanitizedUrl: string }
  | { allowed: false; reason: string };

export type RuntimeRestorationPlan =
  | { kind: "resume-active"; runtime: PersistedActiveRuntime }
  | { kind: "purge-stopping"; runtime: PersistedStoppingRuntime }
  | { kind: "retain-stopped"; runtime: PersistedStoppedRuntime };

export type PersistedRuntimeIdentity = {
  sid: string;
  tabId: number;
  startedAt: number;
};

export type RuntimeCleanupAlarmApi = {
  create(name: string, alarmInfo: { when: number }): void | Promise<void>;
  clear(name: string): boolean | Promise<boolean>;
};

export type RuntimeSequenceWatermark = {
  event: number;
  action: number;
};

export type RuntimeScreenRecordingChunkReference = {
  index: number;
  hash: string;
  size?: number;
};

export type RuntimeOffscreenScreenRecordingStatus =
  | { active: false }
  | {
      active: true;
      recordingId: string;
      mime: string;
      width?: number;
      height?: number;
      frameRate?: number;
    };

export type InterruptedScreenRecordingRecovery = {
  recordingId: string;
  mime: string;
  chunks: readonly RuntimeScreenRecordingChunkReference[];
  sizeBytes: number;
  startedAt?: number;
  width?: number;
  height?: number;
  frameRate?: number;
};

export type RuntimeCleanupSchedulerOptions = {
  alarms?: RuntimeCleanupAlarmApi;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  retryDelayMs?: number;
  onDue: (sid: string) => void | Promise<void>;
};

export type VolatileCaptureFence = {
  blocked: boolean;
};

export type DurableRuntimeStopWorkflowOptions = {
  captureFence: VolatileCaptureFence;
  persistStopping: () => void | Promise<void>;
  teardownSteps: ReadonlyArray<() => void | Promise<void>>;
  persistStopped: () => void | Promise<void>;
};

export type DurableStopTombstoneOptions = {
  persist: () => void | Promise<void>;
  activate: () => void;
};

export type StoppingRuntimeRecoveryOptions = {
  getScreenRecordingStatus: () =>
    | RuntimeOffscreenScreenRecordingStatus
    | Promise<RuntimeOffscreenScreenRecordingStatus>;
  stopScreenRecording: (
    status: Extract<RuntimeOffscreenScreenRecordingStatus, { active: true }>
  ) => void | Promise<void>;
  purge: () => void | Promise<void>;
};

export type ActiveRuntimeRestorationTransactionOptions<TRuntime extends object> = {
  startPipeline: () => void | Promise<void>;
  prepareRuntime: () => TRuntime | Promise<TRuntime>;
  registerRuntime: (runtime: TRuntime) => void;
  completeRuntime: (runtime: TRuntime) => void | Promise<void>;
  cleanupPipeline: () => void | Promise<void>;
  cleanupRuntime: (runtime: TRuntime) => void | Promise<void>;
};

export type ActiveRuntimeRestorationTransactionResult<TRuntime extends object> =
  | Readonly<{ kind: "restored"; runtime: TRuntime }>
  | Readonly<{
      kind: "failed-cleaned";
      phase: "pipeline" | "runtime";
      error: unknown;
      cleanupError?: unknown;
    }>;

export type DurableFailedRuntimeCleanupOptions = {
  persistStopping: () => void | Promise<void>;
  cleanup: () => void | Promise<void>;
  clearStopping: () => void | Promise<void>;
};

export class RuntimeStartCoordinator {
  private readonly inFlight = new Map<number, Promise<void>>();

  public run(tabId: number, start: () => Promise<void>): Promise<void> {
    const existing = this.inFlight.get(tabId);

    if (existing) {
      return existing;
    }

    const task = Promise.resolve()
      .then(start)
      .finally(() => {
        if (this.inFlight.get(tabId) === task) {
          this.inFlight.delete(tabId);
        }
      });
    this.inFlight.set(tabId, task);
    return task;
  }
}

/**
 * Treats active-runtime restoration as a two-phase transaction. Once pipeline
 * creation has been attempted, every failure is paired with exactly one
 * cleanup path. Callers can therefore distinguish a rejected checkpoint from
 * a restoration that already removed its partial state and must not be purged
 * again by an outer recovery loop.
 */
export async function runActiveRuntimeRestorationTransaction<TRuntime extends object>(
  options: ActiveRuntimeRestorationTransactionOptions<TRuntime>
): Promise<ActiveRuntimeRestorationTransactionResult<TRuntime>> {
  let runtime: TRuntime | undefined;

  try {
    await options.startPipeline();
    runtime = await options.prepareRuntime();
    options.registerRuntime(runtime);
    await options.completeRuntime(runtime);
    return { kind: "restored", runtime };
  } catch (error) {
    try {
      if (runtime === undefined) {
        await options.cleanupPipeline();
      } else {
        await options.cleanupRuntime(runtime);
      }

      return {
        kind: "failed-cleaned",
        phase: runtime === undefined ? "pipeline" : "runtime",
        error
      };
    } catch (cleanupError) {
      return {
        kind: "failed-cleaned",
        phase: runtime === undefined ? "pipeline" : "runtime",
        error,
        cleanupError
      };
    }
  }
}

/**
 * Makes the failure tombstone durable before destructive restoration cleanup,
 * then removes it only after cleanup is complete. A crash at either boundary
 * therefore resumes as stopping recovery, never as active capture.
 */
export async function runDurableFailedRuntimeCleanup(
  options: DurableFailedRuntimeCleanupOptions
): Promise<void> {
  await options.persistStopping();
  await options.cleanup();
  await options.clearStopping();
}

/** Prevents teardown callbacks from observing or acting on a replacement runtime. */
export async function disposeListenersBeforeTeardown(
  listeners: readonly (() => void)[],
  teardown: () => void | Promise<void>
): Promise<void> {
  for (const dispose of listeners) {
    dispose();
  }

  await teardown();
}

/** Deletes a shared-map entry only when it still names the failed runtime. */
export function isMapEntrySame<TKey, TValue>(
  map: ReadonlyMap<TKey, TValue>,
  key: TKey,
  expected: TValue
): boolean {
  return map.get(key) === expected;
}

export function deleteMapEntryIfSame<TKey, TValue>(
  map: Map<TKey, TValue>,
  key: TKey,
  expected: TValue
): boolean {
  if (!isMapEntrySame(map, key, expected)) {
    return false;
  }

  return map.delete(key);
}

/** Creates the per-runtime fence. Only authoritative session creation may start it open. */
export function createVolatileCaptureFence(blocked = false): VolatileCaptureFence {
  return { blocked };
}

/** Closes capture synchronously. There is intentionally no corresponding reopen operation. */
export function blockVolatileCapture(fence: VolatileCaptureFence): void {
  fence.blocked = true;
}

export function isVolatileCaptureOpen(fence: VolatileCaptureFence): boolean {
  return !fence.blocked;
}

/** Drops the result of work that crosses a fence closure; callers must not publish references. */
export async function runVolatileCaptureOperation<T>(
  fence: VolatileCaptureFence,
  operation: () => Promise<T>
): Promise<T | null> {
  if (!isVolatileCaptureOpen(fence)) {
    return null;
  }

  const result = await operation();
  return isVolatileCaptureOpen(fence) ? result : null;
}

/** Closes capture immediately, then runs no teardown until stop is durably checkpointed. */
export async function runDurableRuntimeStopWorkflow(
  options: DurableRuntimeStopWorkflowOptions
): Promise<void> {
  blockVolatileCapture(options.captureFence);
  await options.persistStopping();

  for (const step of options.teardownSteps) {
    await step();
  }

  await options.persistStopped();
}

/** Activates the in-memory stop marker only after its durable write succeeds. */
export async function persistDurableStopTombstone(
  options: DurableStopTombstoneOptions
): Promise<void> {
  await options.persist();
  options.activate();
}

/** Stopping tombstones are never eligible for active capture restoration. */
export function planRuntimeRestoration(runtime: PersistedRuntime): RuntimeRestorationPlan {
  if (runtime.state === "active") {
    return { kind: "resume-active", runtime };
  }

  if (runtime.state === "stopping") {
    return { kind: "purge-stopping", runtime };
  }

  return { kind: "retain-stopped", runtime };
}

/** Stops any recorder that survived the worker before purging its stopped session. */
export async function recoverStoppingRuntimeFailClosed(
  options: StoppingRuntimeRecoveryOptions
): Promise<void> {
  try {
    const status = await options.getScreenRecordingStatus();

    if (status.active) {
      await options.stopScreenRecording(status);
    }
  } finally {
    await options.purge();
  }
}

/**
 * Parses the versioned service-worker checkpoint as an all-or-nothing unit.
 * A single malformed or unexpected field rejects the complete checkpoint so
 * recovery cannot silently downgrade policy or mix trusted and corrupt rows.
 */
export function parseRuntimeStateSnapshot(input: unknown): RuntimeStateSnapshot | null {
  const record = asStrictRecord(input, ["schemaVersion", "savedAt", "sessions"]);

  if (
    !record ||
    record.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION ||
    !isFiniteNonNegativeNumber(record.savedAt) ||
    !Array.isArray(record.sessions) ||
    record.sessions.length > MAX_PERSISTED_SESSIONS
  ) {
    return null;
  }

  const sessions: PersistedRuntime[] = [];
  const seenSids = new Set<string>();
  const seenActiveTabs = new Set<number>();

  for (const value of record.sessions) {
    const session = parsePersistedRuntime(value);

    if (!session || seenSids.has(session.sid)) {
      return null;
    }

    if (session.state === "active") {
      if (seenActiveTabs.has(session.tabId)) {
        return null;
      }
      seenActiveTabs.add(session.tabId);
    }

    seenSids.add(session.sid);
    sessions.push(session);
  }

  return {
    schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
    savedAt: record.savedAt,
    sessions
  };
}

export function createRuntimeStateSnapshot(
  sessions: readonly PersistedRuntime[],
  savedAt = Date.now()
): RuntimeStateSnapshot {
  return {
    schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
    savedAt,
    sessions: sessions.map(clonePersistedRuntime)
  };
}

export function createStoppingRuntimeTombstone(
  runtime: PersistedActiveRuntime,
  stopRequestedAt: number,
  cleanupDeadline: number
): PersistedStoppingRuntime {
  return {
    ...runtime,
    state: "stopping",
    stopRequestedAt,
    cleanupDeadline
  };
}

/** Retained stopping tombstones override same-session rows so later writes cannot revive capture. */
export function mergeRuntimeStateWithStoppingTombstones(
  sessions: readonly PersistedRuntime[],
  tombstones: readonly PersistedStoppingRuntime[]
): PersistedRuntime[] {
  const merged = new Map<string, PersistedRuntime>();

  for (const session of sessions) {
    merged.set(session.sid, session);
  }

  for (const tombstone of tombstones) {
    merged.set(tombstone.sid, tombstone);
  }

  return [...merged.values()];
}

/** Extracts only non-sensitive identifiers used to fail-closed purge a corrupt checkpoint. */
export function extractPersistedRuntimeIdentities(input: unknown): PersistedRuntimeIdentity[] {
  const root = asRecord(input);
  const values = Array.isArray(input)
    ? input
    : root && Array.isArray(root.sessions)
      ? root.sessions
      : [];
  const identities: PersistedRuntimeIdentity[] = [];
  const seen = new Set<string>();

  for (const value of values.slice(0, MAX_PERSISTED_SESSIONS)) {
    const record = asRecord(value);

    if (
      typeof record?.sid !== "string" ||
      !SESSION_ID_PATTERN.test(record.sid) ||
      !isNonNegativeSafeInteger(record.tabId) ||
      !isFiniteNonNegativeNumber(record.startedAt) ||
      seen.has(record.sid)
    ) {
      continue;
    }

    seen.add(record.sid);
    identities.push({
      sid: record.sid,
      tabId: record.tabId,
      startedAt: record.startedAt
    });
  }

  return identities;
}

export function evaluateActiveRuntimeRestoration(
  runtime: PersistedActiveRuntime,
  tab: { id?: number; url?: string } | null | undefined,
  now = Date.now()
): ActiveRuntimeRestorationDecision {
  if (tab?.id !== runtime.tabId || typeof tab.url !== "string" || tab.url.length === 0) {
    return { allowed: false, reason: "tab-missing" };
  }

  const decision = evaluateCaptureScope(runtime.config.capturePolicy, {
    url: tab.url,
    tabId: runtime.tabId,
    frameId: 0,
    topLevel: true,
    now
  });

  if (!decision.allowed) {
    return { allowed: false, reason: decision.reason };
  }

  return {
    allowed: true,
    captureUrl: tab.url,
    sanitizedUrl: sanitizeUrlForPrivacy(tab.url)
  };
}

/** Never extends an already-persisted retention deadline when policy changes. */
export function capCleanupDeadline(
  stoppedAt: number,
  persistedDeadline: number,
  localTtlMs: number
): number {
  return Math.min(persistedDeadline, stoppedAt + localTtlMs);
}

export function mergeRuntimeCountersWithSequenceWatermark(
  counters: PersistedRuntimeCounters,
  watermark: RuntimeSequenceWatermark
): PersistedRuntimeCounters {
  return {
    ...counters,
    recorderEventSequence: Math.max(counters.recorderEventSequence, watermark.event),
    recorderActionSequence: Math.max(counters.recorderActionSequence, watermark.action)
  };
}

export function restoreScreenRecordingChunkHashes(
  persistedChunkCount: number,
  references: readonly RuntimeScreenRecordingChunkReference[]
): string[] {
  if (
    !Number.isSafeInteger(persistedChunkCount) ||
    persistedChunkCount < 0 ||
    persistedChunkCount > MAX_SCREEN_RECORDING_CHUNKS ||
    references.some(
      (reference) =>
        !Number.isSafeInteger(reference.index) ||
        reference.index < 0 ||
        reference.index >= MAX_SCREEN_RECORDING_CHUNKS
    )
  ) {
    throw new Error("Invalid screen-recording resume chunk range.");
  }

  const maxIndex = references.reduce(
    (maximum, reference) => Math.max(maximum, reference.index),
    -1
  );
  const chunks = new Array<string>(Math.max(persistedChunkCount, maxIndex + 1));

  for (const reference of references) {
    chunks[reference.index] = reference.hash;
  }

  return chunks;
}

/** Pipeline references are the durable source of truth when a debounced MV3 snapshot is ahead. */
export function deriveDurableScreenRecordingChunkCount(
  references: readonly RuntimeScreenRecordingChunkReference[]
): number {
  if (
    references.some(
      (reference) =>
        !Number.isSafeInteger(reference.index) ||
        reference.index < 0 ||
        reference.index >= MAX_SCREEN_RECORDING_CHUNKS
    )
  ) {
    throw new Error("Invalid durable screen-recording chunk range.");
  }

  return references.reduce((count, reference) => Math.max(count, reference.index + 1), 0);
}

export function reconcileScreenRecordingResumeState(
  persisted: PersistedScreenRecording | undefined,
  durable:
    | {
        recordingId: string;
        chunks: readonly RuntimeScreenRecordingChunkReference[];
      }
    | undefined
): {
  screenRecording: PersistedScreenRecording | undefined;
  chunks: readonly RuntimeScreenRecordingChunkReference[] | undefined;
} {
  if (!persisted || !durable || durable.recordingId !== persisted.recordingId) {
    return {
      screenRecording: undefined,
      chunks: undefined
    };
  }

  return {
    screenRecording: {
      ...persisted,
      chunkCount: deriveDurableScreenRecordingChunkCount(durable.chunks),
      sizeBytes: deriveDurableScreenRecordingSize(persisted, durable.chunks)
    },
    chunks: durable.chunks
  };
}

export function normalizeOffscreenScreenRecordingStatus(
  raw: unknown
): RuntimeOffscreenScreenRecordingStatus {
  const row = asRecord(raw);

  if (!row || typeof row.active !== "boolean") {
    throw new Error("Invalid offscreen screen-recording status.");
  }

  if (!row.active && Object.keys(row).length === 1) {
    return { active: false };
  }

  if (
    row.active &&
    Object.keys(row).every((key) =>
      ["active", "recordingId", "mime", "width", "height", "frameRate"].includes(key)
    ) &&
    typeof row.recordingId === "string" &&
    row.recordingId.length > 0 &&
    row.recordingId.length <= 256 &&
    typeof row.mime === "string" &&
    row.mime.length > 0 &&
    row.mime.length <= 256 &&
    isOptionalPositiveNumber(row.width) &&
    isOptionalPositiveNumber(row.height) &&
    isOptionalPositiveNumber(row.frameRate)
  ) {
    return {
      active: true,
      recordingId: row.recordingId,
      mime: row.mime,
      ...(row.width === undefined ? {} : { width: row.width as number }),
      ...(row.height === undefined ? {} : { height: row.height as number }),
      ...(row.frameRate === undefined ? {} : { frameRate: row.frameRate as number })
    };
  }

  throw new Error("Invalid offscreen screen-recording status.");
}

export function buildInterruptedScreenRecordingRecoveries(input: {
  persisted: PersistedScreenRecording | undefined;
  resumeState: PipelineResumeState;
  status: RuntimeOffscreenScreenRecordingStatus;
  claimedRecordingId: string | undefined;
}): InterruptedScreenRecordingRecovery[] {
  const recordingIds = new Set(
    input.resumeState.screenRecordings
      .map((recording) => recording.recordingId)
      .filter((recordingId) => recordingId !== input.claimedRecordingId)
  );

  if (input.persisted && input.persisted.recordingId !== input.claimedRecordingId) {
    recordingIds.add(input.persisted.recordingId);
  }

  if (input.status.active && input.status.recordingId !== input.claimedRecordingId) {
    recordingIds.add(input.status.recordingId);
  }

  return [...recordingIds]
    .sort((left, right) => left.localeCompare(right))
    .map((recordingId) => {
      const durable = input.resumeState.screenRecordings.find(
        (recording) => recording.recordingId === recordingId
      );
      const persisted = input.persisted?.recordingId === recordingId ? input.persisted : undefined;
      const status =
        input.status.active && input.status.recordingId === recordingId ? input.status : undefined;
      const reconciled = reconcileScreenRecordingResumeState(persisted, durable);
      const chunks = durable?.chunks ?? [];
      const knownSize = chunks.reduce(
        (total, chunk) => Math.min(Number.MAX_SAFE_INTEGER, total + (chunk.size ?? 0)),
        0
      );

      return {
        recordingId,
        mime: persisted?.mime ?? status?.mime ?? "video/webm",
        chunks,
        sizeBytes: reconciled.screenRecording?.sizeBytes ?? knownSize,
        ...(persisted ? { startedAt: persisted.startedAt } : {}),
        ...((persisted?.width ?? status?.width)
          ? { width: persisted?.width ?? status?.width }
          : {}),
        ...((persisted?.height ?? status?.height)
          ? { height: persisted?.height ?? status?.height }
          : {}),
        ...((persisted?.frameRate ?? status?.frameRate)
          ? { frameRate: persisted?.frameRate ?? status?.frameRate }
          : {})
      };
    });
}

function deriveDurableScreenRecordingSize(
  persisted: PersistedScreenRecording,
  references: readonly RuntimeScreenRecordingChunkReference[]
): number {
  const knownSize = references.reduce(
    (total, reference) => Math.min(Number.MAX_SAFE_INTEGER, total + (reference.size ?? 0)),
    0
  );

  if (references.every((reference) => reference.size !== undefined)) {
    return knownSize;
  }

  const indexes = new Set(references.map((reference) => reference.index));
  let snapshotMatchesDurablePrefix = references.length === persisted.chunkCount;

  for (let index = 0; snapshotMatchesDurablePrefix && index < persisted.chunkCount; index += 1) {
    snapshotMatchesDurablePrefix = indexes.has(index);
  }

  return snapshotMatchesDurablePrefix ? persisted.sizeBytes : knownSize;
}

export function compactScreenRecordingChunkHashes(chunks: readonly string[]): string[] {
  return chunks.filter((chunk) => typeof chunk === "string" && chunk.length > 0);
}

export function createRuntimeCleanupAlarmName(sid: string): string {
  return `${RUNTIME_CLEANUP_ALARM_PREFIX}${sid}`;
}

export function parseRuntimeCleanupAlarmName(name: string): string | null {
  if (!name.startsWith(RUNTIME_CLEANUP_ALARM_PREFIX)) {
    return null;
  }

  const sid = name.slice(RUNTIME_CLEANUP_ALARM_PREFIX.length);
  return SESSION_ID_PATTERN.test(sid) ? sid : null;
}

/**
 * Uses both a best-effort in-memory timer and chrome.alarms. The timer gives
 * prompt cleanup while the alarm is the MV3 restart/suspension-safe source.
 */
export class RuntimeCleanupScheduler {
  private readonly alarms: RuntimeCleanupAlarmApi | undefined;
  private readonly now: () => number;
  private readonly setTimer: (
    callback: () => void,
    delayMs: number
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly onDue: (sid: string) => void | Promise<void>;
  private readonly retryDelayMs: number;
  private readonly deadlines = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly dueTasks = new Map<string, Promise<void>>();

  public constructor(options: RuntimeCleanupSchedulerOptions) {
    this.alarms = options.alarms;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onDue = options.onDue;
    this.retryDelayMs = Math.max(1, Math.round(options.retryDelayMs ?? 60_000));
  }

  public async schedule(sid: string, deadline: number): Promise<void> {
    if (!SESSION_ID_PATTERN.test(sid) || !isFiniteNonNegativeNumber(deadline)) {
      throw new Error("Invalid stopped-session cleanup schedule.");
    }

    this.cancelTimer(sid);
    this.deadlines.set(sid, deadline);

    const delay = deadline - this.now();

    if (delay <= 0) {
      await this.runDue(sid);
      return;
    }

    const alarmName = createRuntimeCleanupAlarmName(sid);
    let alarmError: unknown;

    try {
      await this.alarms?.clear(alarmName);
      await this.alarms?.create(alarmName, { when: deadline });
    } catch (error) {
      alarmError = error;
    }

    const timer = this.setTimer(
      () => {
        this.timers.delete(sid);
        void this.handleDueSignal(sid);
      },
      Math.min(delay, MAX_TIMER_DELAY_MS)
    );
    this.timers.set(sid, timer);

    if (alarmError) {
      throw alarmError;
    }
  }

  public async cancel(sid: string): Promise<void> {
    this.deadlines.delete(sid);
    this.cancelTimer(sid);
    await this.alarms?.clear(createRuntimeCleanupAlarmName(sid));
  }

  public async handleAlarm(name: string): Promise<boolean> {
    const sid = parseRuntimeCleanupAlarmName(name);

    if (!sid || !this.deadlines.has(sid)) {
      return false;
    }

    await this.handleDueSignal(sid);
    return true;
  }

  public getDeadline(sid: string): number | undefined {
    return this.deadlines.get(sid);
  }

  private async handleDueSignal(sid: string): Promise<void> {
    const deadline = this.deadlines.get(sid);

    if (deadline === undefined) {
      return;
    }

    if (this.now() < deadline) {
      await this.schedule(sid, deadline);
      return;
    }

    await this.runDue(sid);
  }

  private async runDue(sid: string): Promise<void> {
    const existing = this.dueTasks.get(sid);

    if (existing) {
      await existing;
      return;
    }

    this.cancelTimer(sid);
    const task = Promise.resolve()
      .then(() => this.onDue(sid))
      .then(async () => {
        this.deadlines.delete(sid);
        this.cancelTimer(sid);
        await this.alarms?.clear(createRuntimeCleanupAlarmName(sid));
      })
      .catch(async (error: unknown) => {
        if (this.deadlines.has(sid)) {
          const retryDeadline = this.now() + this.retryDelayMs;
          this.deadlines.set(sid, retryDeadline);
          await this.schedule(sid, retryDeadline).catch(() => undefined);
        }

        throw error;
      })
      .finally(() => {
        this.dueTasks.delete(sid);
      });
    this.dueTasks.set(sid, task);
    await task;
  }

  private cancelTimer(sid: string): void {
    const timer = this.timers.get(sid);

    if (timer !== undefined) {
      this.clearTimer(timer);
      this.timers.delete(sid);
    }
  }
}

function parsePersistedRuntime(input: unknown): PersistedRuntime | null {
  const raw = asRecord(input);

  if (raw?.state === "active") {
    const record = asStrictRecord(input, [
      "state",
      "sid",
      "tabId",
      "mode",
      "url",
      "title",
      "tags",
      "note",
      "config",
      "startedAt",
      "counters",
      "screenRecording"
    ]);
    const base = record ? parsePersistedRuntimeBase(record) : null;
    return base ? { ...base, state: "active" } : null;
  }

  if (raw?.state === "stopped") {
    const record = asStrictRecord(input, [
      "state",
      "sid",
      "tabId",
      "mode",
      "url",
      "title",
      "tags",
      "note",
      "config",
      "startedAt",
      "counters",
      "screenRecording",
      "stoppedAt",
      "cleanupDeadline"
    ]);
    const base = record ? parsePersistedRuntimeBase(record) : null;

    if (
      !base ||
      !isFiniteNonNegativeNumber(record?.stoppedAt) ||
      !isFiniteNonNegativeNumber(record.cleanupDeadline) ||
      record.stoppedAt < base.startedAt ||
      record.cleanupDeadline < record.stoppedAt
    ) {
      return null;
    }

    return {
      ...base,
      state: "stopped",
      stoppedAt: record.stoppedAt,
      cleanupDeadline: record.cleanupDeadline
    };
  }

  if (raw?.state === "stopping") {
    const record = asStrictRecord(input, [
      "state",
      "sid",
      "tabId",
      "mode",
      "url",
      "title",
      "tags",
      "note",
      "config",
      "startedAt",
      "counters",
      "screenRecording",
      "stopRequestedAt",
      "cleanupDeadline"
    ]);
    const base = record ? parsePersistedRuntimeBase(record) : null;

    if (
      !base ||
      !isFiniteNonNegativeNumber(record?.stopRequestedAt) ||
      !isFiniteNonNegativeNumber(record.cleanupDeadline) ||
      record.stopRequestedAt < base.startedAt ||
      record.cleanupDeadline < record.stopRequestedAt
    ) {
      return null;
    }

    return {
      ...base,
      state: "stopping",
      stopRequestedAt: record.stopRequestedAt,
      cleanupDeadline: record.cleanupDeadline
    };
  }

  return null;
}

function parsePersistedRuntimeBase(record: Record<string, unknown>): PersistedRuntimeBase | null {
  const parsedConfig = recorderConfigSchema.safeParse(record.config);
  const mode = record.mode;
  const config = parsedConfig.success ? parsedConfig.data : null;
  const counters = parseCounters(record.counters);
  const screenRecording = parseScreenRecording(record.screenRecording);

  if (
    typeof record.sid !== "string" ||
    !SESSION_ID_PATTERN.test(record.sid) ||
    !isNonNegativeSafeInteger(record.tabId) ||
    (mode !== "lite" && mode !== "full") ||
    typeof record.url !== "string" ||
    record.url.length === 0 ||
    record.url.length > 4_096 ||
    (record.title !== undefined &&
      (typeof record.title !== "string" || record.title.length > 1_024)) ||
    !isStringList(record.tags, 12, 40) ||
    (record.note !== undefined && (typeof record.note !== "string" || record.note.length > 500)) ||
    !config ||
    config.mode !== mode ||
    !config.capturePolicy ||
    config.capturePolicy.scope.tabId !== record.tabId ||
    JSON.stringify(config.capturePolicy.redaction) !== JSON.stringify(config.redaction) ||
    !isFiniteNonNegativeNumber(record.startedAt) ||
    !counters ||
    (record.screenRecording !== undefined && !screenRecording)
  ) {
    return null;
  }

  return {
    sid: record.sid,
    tabId: record.tabId,
    mode,
    url: record.url,
    title: record.title as string | undefined,
    tags: [...(record.tags as string[])],
    note: record.note as string | undefined,
    config,
    startedAt: record.startedAt,
    counters,
    screenRecording: screenRecording ?? undefined
  };
}

function parseCounters(input: unknown): PersistedRuntimeCounters | null {
  const record = asExactRecord(input, [
    "recorderEventSequence",
    "recorderActionSequence",
    "eventCount",
    "errorCount",
    "sizeBytes",
    "budgetAlertCount",
    "droppedBestEffortTasks",
    "responseBodyCaptures",
    "networkTotal",
    "networkFailed"
  ]);

  if (!record || !Object.values(record).every(isNonNegativeSafeInteger)) {
    return null;
  }

  const counters = record as PersistedRuntimeCounters;

  if (
    counters.errorCount > counters.eventCount ||
    counters.networkFailed > counters.networkTotal ||
    counters.recorderEventSequence < counters.eventCount ||
    counters.recorderActionSequence > counters.recorderEventSequence
  ) {
    return null;
  }

  return counters;
}

function parseScreenRecording(input: unknown): PersistedScreenRecording | null {
  if (input === undefined) {
    return null;
  }

  const record = asStrictRecord(input, [
    "recordingId",
    "startedAt",
    "startedMono",
    "mime",
    "width",
    "height",
    "frameRate",
    "chunkCount",
    "sizeBytes"
  ]);

  if (
    !record ||
    typeof record.recordingId !== "string" ||
    record.recordingId.length === 0 ||
    record.recordingId.length > 256 ||
    !isFiniteNonNegativeNumber(record.startedAt) ||
    !isFiniteNonNegativeNumber(record.startedMono) ||
    typeof record.mime !== "string" ||
    record.mime.length === 0 ||
    record.mime.length > 256 ||
    !isOptionalPositiveNumber(record.width) ||
    !isOptionalPositiveNumber(record.height) ||
    !isOptionalPositiveNumber(record.frameRate) ||
    !isNonNegativeSafeInteger(record.chunkCount) ||
    (record.chunkCount as number) > MAX_SCREEN_RECORDING_CHUNKS ||
    !isNonNegativeSafeInteger(record.sizeBytes)
  ) {
    return null;
  }

  return record as PersistedScreenRecording;
}

function clonePersistedRuntime(runtime: PersistedRuntime): PersistedRuntime {
  return structuredClone(runtime);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStrictRecord(
  value: unknown,
  allowedKeys: readonly string[]
): Record<string, unknown> | null {
  const record = asRecord(value);

  if (!record) {
    return null;
  }

  const allowed = new Set(allowedKeys);

  return Object.keys(record).every((key) => allowed.has(key)) ? record : null;
}

function asExactRecord(
  value: unknown,
  requiredKeys: readonly string[]
): Record<string, unknown> | null {
  const record = asStrictRecord(value, requiredKeys);

  if (!record || requiredKeys.some((key) => !Object.hasOwn(record, key))) {
    return null;
  }

  return record;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalPositiveNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value > 0);
}

function isStringList(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === "string" && item.length > 0 && item.length <= maxLength)
  );
}
