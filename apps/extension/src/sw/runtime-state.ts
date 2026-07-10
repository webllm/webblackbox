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

export type PersistedStoppedRuntime = PersistedRuntimeBase & {
  state: "stopped";
  stoppedAt: number;
  cleanupDeadline: number;
};

export type PersistedRuntime = PersistedActiveRuntime | PersistedStoppedRuntime;

export type RuntimeStateSnapshot = {
  schemaVersion: typeof RUNTIME_STATE_SCHEMA_VERSION;
  savedAt: number;
  sessions: PersistedRuntime[];
};

export type ActiveRuntimeRestorationDecision =
  | { allowed: true; captureUrl: string; sanitizedUrl: string }
  | { allowed: false; reason: string };

export type PersistedRuntimeIdentity = {
  sid: string;
  tabId: number;
  startedAt: number;
};

export type RuntimeCleanupAlarmApi = {
  create(name: string, alarmInfo: { when: number }): void | Promise<void>;
  clear(name: string): boolean | Promise<boolean>;
};

export type RuntimeCleanupSchedulerOptions = {
  alarms?: RuntimeCleanupAlarmApi;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onDue: (sid: string) => void | Promise<void>;
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
  private readonly deadlines = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly dueTasks = new Map<string, Promise<void>>();

  public constructor(options: RuntimeCleanupSchedulerOptions) {
    this.alarms = options.alarms;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onDue = options.onDue;
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
    await this.alarms?.clear(alarmName);
    await this.alarms?.create(alarmName, { when: deadline });

    const timer = this.setTimer(
      () => {
        this.timers.delete(sid);
        void this.handleDueSignal(sid);
      },
      Math.min(delay, MAX_TIMER_DELAY_MS)
    );
    this.timers.set(sid, timer);
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

    this.deadlines.delete(sid);
    this.cancelTimer(sid);
    const task = Promise.resolve(this.onDue(sid)).finally(() => {
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
