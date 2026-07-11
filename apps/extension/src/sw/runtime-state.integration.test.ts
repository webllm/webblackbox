import { DEFAULT_RECORDER_CONFIG, type RecorderConfig } from "@webblackbox/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeCleanupScheduler,
  capCleanupDeadline,
  createRuntimeCleanupAlarmName,
  createRuntimeStateSnapshot,
  createStoppedRuntimeTombstone,
  createStoppingRuntimeTombstone,
  evaluateActiveRuntimeRestoration,
  extractPersistedRuntimeIdentities,
  parseRuntimeStateSnapshot,
  planRuntimeRestoration,
  type PersistedActiveRuntime,
  type PersistedRuntimeCounters,
  type PersistedStoppedRuntime,
  type PersistedStoppingRuntime
} from "./runtime-state.js";

const STARTED_AT = Date.parse("2026-06-01T00:00:00.000Z");
const COUNTERS: PersistedRuntimeCounters = {
  recorderEventSequence: 88,
  recorderActionSequence: 12,
  eventCount: 88,
  errorCount: 2,
  sizeBytes: 10_000,
  budgetAlertCount: 1,
  droppedBestEffortTasks: 0,
  responseBodyCaptures: 3,
  networkTotal: 30,
  networkFailed: 2
};

function config(tabId: number, expiresAt?: string): RecorderConfig {
  const next = structuredClone(DEFAULT_RECORDER_CONFIG);
  next.capturePolicy = {
    ...next.capturePolicy!,
    consent: {
      ...next.capturePolicy!.consent,
      grantedAt: new Date(STARTED_AT).toISOString(),
      ...(expiresAt ? { expiresAt } : {})
    },
    scope: {
      ...next.capturePolicy!.scope,
      tabId,
      origin: "https://app.example"
    },
    redaction: structuredClone(next.redaction)
  };
  return next;
}

function active(expiresAt?: string): PersistedActiveRuntime {
  return {
    state: "active",
    sid: "S-1780272000000-active",
    tabId: 41,
    mode: "lite",
    url: "https://app.example/home",
    title: "App",
    tags: ["restart"],
    config: config(41, expiresAt),
    startedAt: STARTED_AT,
    counters: { ...COUNTERS }
  };
}

function stopped(): PersistedStoppedRuntime {
  const stoppedAt = STARTED_AT + 60_000;
  return {
    ...active(),
    state: "stopped",
    sid: "S-1780272060000-stopped",
    stoppedAt,
    cleanupDeadline: stoppedAt + 86_400_000
  };
}

function stopping(): PersistedStoppingRuntime {
  const stopRequestedAt = STARTED_AT + 30_000;
  return {
    ...active(),
    state: "stopping",
    sid: "S-1780272030000-stopping",
    stopRequestedAt,
    cleanupDeadline: stopRequestedAt + 86_400_000
  };
}

describe("service-worker restart recovery integration", () => {
  it("restores a valid active checkpoint and re-arms stopped TTL cleanup after restart", async () => {
    const rawStorageValue = structuredClone(
      createRuntimeStateSnapshot([active(), stopped()], STARTED_AT + 120_000)
    );
    const restored = parseRuntimeStateSnapshot(rawStorageValue);
    expect(restored?.sessions).toHaveLength(2);

    const activeRow = restored!.sessions[0] as PersistedActiveRuntime;
    expect(
      evaluateActiveRuntimeRestoration(
        activeRow,
        { id: 41, url: "https://app.example/after-restart" },
        STARTED_AT + 120_000
      )
    ).toMatchObject({ allowed: true });
    expect(activeRow.counters.recorderEventSequence).toBe(88);

    let now = STARTED_AT + 120_000;
    const alarmCreate = vi.fn();
    const purge = vi.fn();
    const scheduler = new RuntimeCleanupScheduler({
      alarms: { create: alarmCreate, clear: vi.fn().mockResolvedValue(true) },
      now: () => now,
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      onDue: purge
    });
    const stoppedRow = restored!.sessions[1] as PersistedStoppedRuntime;
    const cappedDeadline = capCleanupDeadline(
      stoppedRow.stoppedAt,
      stoppedRow.cleanupDeadline,
      3_600_000
    );

    await scheduler.schedule(stoppedRow.sid, cappedDeadline);
    expect(alarmCreate).toHaveBeenCalledWith(createRuntimeCleanupAlarmName(stoppedRow.sid), {
      when: cappedDeadline
    });
    now = cappedDeadline + 1;
    await scheduler.handleAlarm(createRuntimeCleanupAlarmName(stoppedRow.sid));
    expect(purge).toHaveBeenCalledWith(stoppedRow.sid);
  });

  it("rejects missing tabs and expired consent instead of re-enabling capture", () => {
    expect(evaluateActiveRuntimeRestoration(active(), null, STARTED_AT + 1)).toEqual({
      allowed: false,
      reason: "tab-missing"
    });

    const expiresAt = new Date(STARTED_AT + 30_000).toISOString();
    expect(
      evaluateActiveRuntimeRestoration(
        active(expiresAt),
        { id: 41, url: "https://app.example/home" },
        STARTED_AT + 30_001
      )
    ).toEqual({ allowed: false, reason: "consent-expired" });
  });

  it("routes a crash-persisted stopping tombstone to retained stopped finalization", () => {
    const snapshot = parseRuntimeStateSnapshot(
      createRuntimeStateSnapshot([stopping()], STARTED_AT + 31_000)
    );
    const row = snapshot?.sessions[0];

    expect(row?.state).toBe("stopping");
    expect(row && planRuntimeRestoration(row)).toMatchObject({
      kind: "finalize-stopping",
      runtime: {
        sid: "S-1780272030000-stopping",
        stopRequestedAt: STARTED_AT + 30_000
      }
    });

    const finalized = createStoppedRuntimeTombstone(
      row as PersistedStoppingRuntime,
      (row as PersistedStoppingRuntime).stopRequestedAt,
      (row as PersistedStoppingRuntime).cleanupDeadline
    );
    expect(finalized).toMatchObject({
      state: "stopped",
      sid: "S-1780272030000-stopping",
      stoppedAt: STARTED_AT + 30_000,
      counters: COUNTERS
    });
    expect(parseRuntimeStateSnapshot(createRuntimeStateSnapshot([finalized]))?.sessions[0]).toEqual(
      finalized
    );
  });

  it("retains a rejected active restore as exportable stopping data instead of purging it", () => {
    const rejected = active();
    rejected.screenRecording = {
      recordingId: "VR-rejected-restore",
      startedAt: STARTED_AT + 1_000,
      startedMono: 1_000,
      mime: "video/webm",
      chunkCount: 2,
      sizeBytes: 512
    };
    const failedAt = STARTED_AT + 45_000;
    const retained = createStoppingRuntimeTombstone(rejected, failedAt, failedAt + 86_400_000);
    const checkpoint = parseRuntimeStateSnapshot(createRuntimeStateSnapshot([retained]));

    expect(checkpoint?.sessions[0]).toMatchObject({
      state: "stopping",
      sid: rejected.sid,
      counters: COUNTERS,
      screenRecording: {
        recordingId: "VR-rejected-restore",
        chunkCount: 2,
        sizeBytes: 512
      }
    });
    expect(planRuntimeRestoration(checkpoint!.sessions[0]!)).toMatchObject({
      kind: "finalize-stopping"
    });

    const stopped = createStoppedRuntimeTombstone(retained, failedAt, retained.cleanupDeadline);
    expect(stopped).toMatchObject({
      state: "stopped",
      sid: rejected.sid,
      counters: COUNTERS
    });
  });

  it("rejects a corrupt checkpoint while retaining only safe purge identities", () => {
    const snapshot = createRuntimeStateSnapshot([active()]);
    const corrupt = {
      ...snapshot,
      sessions: [{ ...snapshot.sessions[0], injectedKey: "must-fail-closed" }]
    };

    expect(parseRuntimeStateSnapshot(corrupt)).toBeNull();
    expect(extractPersistedRuntimeIdentities(corrupt)).toEqual([
      {
        sid: "S-1780272000000-active",
        tabId: 41,
        startedAt: STARTED_AT
      }
    ]);
  });

  it("migrates legacy and unsupported storage versions by failing closed to purge identities", () => {
    const legacy = [
      {
        sid: "S-1780272000000-legacy",
        tabId: 41,
        mode: "lite",
        startedAt: STARTED_AT
      }
    ];
    expect(parseRuntimeStateSnapshot(legacy)).toBeNull();
    expect(extractPersistedRuntimeIdentities(legacy)).toEqual([
      {
        sid: "S-1780272000000-legacy",
        tabId: 41,
        startedAt: STARTED_AT
      }
    ]);

    const futureVersion = {
      ...createRuntimeStateSnapshot([active()]),
      schemaVersion: 2
    };
    expect(parseRuntimeStateSnapshot(futureVersion)).toBeNull();
    expect(extractPersistedRuntimeIdentities(futureVersion)).toHaveLength(1);
  });
});
