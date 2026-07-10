import { DEFAULT_RECORDER_CONFIG, type RecorderConfig } from "@webblackbox/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeCleanupScheduler,
  RuntimeStartCoordinator,
  capCleanupDeadline,
  createRuntimeCleanupAlarmName,
  createRuntimeStateSnapshot,
  evaluateActiveRuntimeRestoration,
  parseRuntimeStateSnapshot,
  type PersistedActiveRuntime,
  type PersistedRuntime
} from "./runtime-state.js";

function createConfig(tabId = 7, expiresAt?: string): RecorderConfig {
  const policy = structuredClone(DEFAULT_RECORDER_CONFIG.capturePolicy!);
  policy.scope = {
    ...policy.scope,
    tabId,
    origin: "https://example.test"
  };
  policy.consent = {
    ...policy.consent,
    grantedAt: "2026-01-01T00:00:00.000Z",
    ...(expiresAt ? { expiresAt } : {})
  };

  return {
    ...structuredClone(DEFAULT_RECORDER_CONFIG),
    capturePolicy: policy,
    redaction: structuredClone(policy.redaction)
  };
}

function createRuntime(
  state: "active" | "stopped" = "active",
  overrides: Partial<PersistedRuntime> = {}
): PersistedRuntime {
  const base = {
    state,
    sid: "S-1767225600000-runtime",
    tabId: 7,
    mode: "lite" as const,
    url: "https://example.test/path",
    title: "Example",
    tags: ["recovery"],
    note: "restart test",
    config: createConfig(),
    startedAt: Date.parse("2026-01-01T00:00:00.000Z"),
    counters: {
      recorderEventSequence: 30,
      recorderActionSequence: 4,
      eventCount: 30,
      errorCount: 1,
      sizeBytes: 4_096,
      budgetAlertCount: 2,
      droppedBestEffortTasks: 3,
      responseBodyCaptures: 4,
      networkTotal: 10,
      networkFailed: 1
    },
    ...overrides
  };

  return state === "stopped"
    ? {
        ...base,
        state: "stopped",
        stoppedAt: Date.parse("2026-01-01T01:00:00.000Z"),
        cleanupDeadline: Date.parse("2026-01-02T01:00:00.000Z")
      }
    : { ...base, state: "active" };
}

describe("runtime state checkpoint", () => {
  it("round-trips active and stopped sessions without events or keys", () => {
    const snapshot = createRuntimeStateSnapshot(
      [createRuntime("active"), createRuntime("stopped", { sid: "S-1767225600001-stopped" })],
      123
    );
    const parsed = parseRuntimeStateSnapshot(snapshot);

    expect(parsed).toEqual(snapshot);
    expect(JSON.stringify(parsed)).not.toMatch(/"events"|"encryptionKey"|"passphrase":/);
  });

  it("rejects the entire checkpoint on unknown fields, invalid policy, or duplicate active tabs", () => {
    const valid = createRuntimeStateSnapshot([createRuntime()]);
    expect(
      parseRuntimeStateSnapshot({
        ...valid,
        unexpected: true
      })
    ).toBeNull();

    const invalidPolicy = structuredClone(valid);
    invalidPolicy.sessions[0]!.config.capturePolicy!.scope.tabId = 8;
    expect(parseRuntimeStateSnapshot(invalidPolicy)).toBeNull();

    const missingCounter = structuredClone(valid) as unknown as {
      sessions: Array<{ counters: Record<string, unknown> }>;
    };
    delete missingCounter.sessions[0]!.counters.recorderEventSequence;
    expect(parseRuntimeStateSnapshot(missingCounter)).toBeNull();

    const duplicateTab = createRuntimeStateSnapshot([
      createRuntime(),
      createRuntime("active", { sid: "S-1767225600001-duplicate" })
    ]);
    expect(parseRuntimeStateSnapshot(duplicateTab)).toBeNull();
  });

  it("fails closed when the tab disappeared or consent expired", () => {
    const runtime = createRuntime() as PersistedActiveRuntime;
    expect(
      evaluateActiveRuntimeRestoration(runtime, null, Date.parse("2026-01-01T00:01:00Z"))
    ).toEqual({ allowed: false, reason: "tab-missing" });

    runtime.config = createConfig(7, "2026-01-01T00:02:00.000Z");
    expect(
      evaluateActiveRuntimeRestoration(
        runtime,
        { id: 7, url: "https://example.test/next" },
        Date.parse("2026-01-01T00:03:00.000Z")
      )
    ).toEqual({ allowed: false, reason: "consent-expired" });
  });

  it("accepts a live same-origin tab and never extends an absolute retention deadline", () => {
    const runtime = createRuntime() as PersistedActiveRuntime;
    expect(
      evaluateActiveRuntimeRestoration(
        runtime,
        { id: 7, url: "https://example.test/next?token=secret" },
        Date.parse("2026-01-01T00:01:00Z")
      )
    ).toMatchObject({
      allowed: true,
      captureUrl: "https://example.test/next?token=secret"
    });

    expect(capCleanupDeadline(1_000, 11_000, 2_000)).toBe(3_000);
    expect(capCleanupDeadline(1_000, 2_000, 5_000)).toBe(2_000);
  });
});

describe("MV3 cleanup scheduling", () => {
  it("arms chrome.alarms plus a timer and purges once after restart alarm delivery", async () => {
    let now = 1_000;
    let timerCallback: (() => void) | undefined;
    const alarmCreate = vi.fn();
    const alarmClear = vi.fn().mockResolvedValue(true);
    const onDue = vi.fn();
    const scheduler = new RuntimeCleanupScheduler({
      alarms: { create: alarmCreate, clear: alarmClear },
      now: () => now,
      setTimer: (callback) => {
        timerCallback = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: vi.fn(),
      onDue
    });

    await scheduler.schedule("S-1767225600001-stopped", 2_000);
    expect(alarmCreate).toHaveBeenCalledWith(
      createRuntimeCleanupAlarmName("S-1767225600001-stopped"),
      { when: 2_000 }
    );
    expect(timerCallback).toBeTypeOf("function");

    now = 2_001;
    await scheduler.handleAlarm(createRuntimeCleanupAlarmName("S-1767225600001-stopped"));
    timerCallback?.();
    await Promise.resolve();
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it("immediately purges an already-expired restored session", async () => {
    const sessions = new Map([["S-1767225600001-expired", { stopped: true }]]);
    const onDue = vi.fn((sid: string) => {
      sessions.delete(sid);
    });
    const scheduler = new RuntimeCleanupScheduler({ now: () => 5_000, onDue });

    await scheduler.schedule("S-1767225600001-expired", 4_999);
    expect(onDue).toHaveBeenCalledOnce();
    expect(sessions.has("S-1767225600001-expired")).toBe(false);
  });
});

describe("runtime start coordination", () => {
  it("coalesces concurrent starts for one tab and allows a later start", async () => {
    const coordinator = new RuntimeStartCoordinator();
    let release!: () => void;
    const firstStart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const first = coordinator.run(7, firstStart);
    const duplicate = coordinator.run(7, firstStart);
    await Promise.resolve();
    expect(firstStart).toHaveBeenCalledOnce();
    expect(duplicate).toBe(first);
    release();
    await first;

    await coordinator.run(
      7,
      firstStart.mockImplementation(async () => undefined)
    );
    expect(firstStart).toHaveBeenCalledTimes(2);
  });
});
