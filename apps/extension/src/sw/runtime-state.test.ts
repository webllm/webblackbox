import { DEFAULT_RECORDER_CONFIG, type RecorderConfig } from "@webblackbox/protocol";
import { WebBlackboxRecorder } from "@webblackbox/recorder";
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeCleanupScheduler,
  RuntimeStartCancelledError,
  RuntimeStartCoordinator,
  RuntimeStartToken,
  buildInterruptedScreenRecordingRecoveries,
  capCleanupDeadline,
  createVolatileCaptureFence,
  createRuntimeCleanupAlarmName,
  createRuntimeStateSnapshot,
  createStoppingRuntimeTombstone,
  compactScreenRecordingChunkHashes,
  commitRestoredRuntimeActivation,
  deleteMapEntryIfSame,
  deriveDurableScreenRecordingChunkCount,
  disposeListenersBeforeTeardown,
  evaluateActiveRuntimeRestoration,
  isMapEntrySame,
  isRuntimeActivationProvisional,
  isRuntimeCaptureAdmitted,
  isVolatileCaptureOpen,
  mergeRuntimeStateWithStoppingTombstones,
  mergeRuntimeCountersWithSequenceWatermark,
  normalizeOffscreenScreenRecordingStatus,
  parseRuntimeStateSnapshot,
  persistDurableStopTombstone,
  planRuntimeRestoration,
  reconcileScreenRecordingResumeState,
  recoverStoppingRuntimeFailClosed,
  restoreScreenRecordingChunkHashes,
  runActiveRuntimeRestorationTransaction,
  runDurableFailedRuntimeCleanup,
  runDurableRuntimeStopWorkflow,
  runProvisionalRuntimeStartTransaction,
  runVolatileCaptureOperation,
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
  state: PersistedRuntime["state"] = "active",
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

  if (state === "active") {
    return { ...base, state: "active" };
  }

  const stopTime = Date.parse("2026-01-01T01:00:00.000Z");
  const cleanupDeadline = Date.parse("2026-01-02T01:00:00.000Z");

  return state === "stopping"
    ? {
        ...base,
        state: "stopping",
        stopRequestedAt: stopTime,
        cleanupDeadline
      }
    : {
        ...base,
        state: "stopped",
        stoppedAt: stopTime,
        cleanupDeadline
      };
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("runtime state checkpoint", () => {
  it("round-trips active, stopping, and stopped sessions without events or keys", () => {
    const snapshot = createRuntimeStateSnapshot(
      [
        createRuntime("active"),
        createRuntime("stopping", { sid: "S-1767225600001-stopping" }),
        createRuntime("stopped", { sid: "S-1767225600002-stopped" })
      ],
      123
    );
    const parsed = parseRuntimeStateSnapshot(snapshot);

    expect(parsed).toEqual(snapshot);
    expect(JSON.stringify(parsed)).not.toMatch(/"events"|"encryptionKey"|"passphrase":/);
  });

  it("never plans active restoration for a durable stopping tombstone", () => {
    expect(planRuntimeRestoration(createRuntime("active")).kind).toBe("resume-active");
    expect(planRuntimeRestoration(createRuntime("stopping")).kind).toBe("purge-stopping");
    expect(planRuntimeRestoration(createRuntime("stopped")).kind).toBe("retain-stopped");
  });

  it("retains a failed recovery tombstone across later active checkpoint writes", () => {
    const active = createRuntime("active");
    const tombstone = createRuntime("stopping", {
      sid: active.sid
    }) as Extract<PersistedRuntime, { state: "stopping" }>;
    const merged = mergeRuntimeStateWithStoppingTombstones([active], [tombstone]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      sid: active.sid,
      state: "stopping",
      stopRequestedAt: tombstone.stopRequestedAt
    });
    expect(planRuntimeRestoration(merged[0]!)).toMatchObject({ kind: "purge-stopping" });
  });

  it("keeps unrelated pending sessions beside a restoration-failure tombstone", () => {
    const failed = createRuntime("active") as PersistedActiveRuntime;
    const other = createRuntime("active", {
      sid: "S-1767225600001-other",
      tabId: 8,
      config: createConfig(8)
    });
    const tombstone = createStoppingRuntimeTombstone(
      failed,
      failed.startedAt + 1_000,
      failed.startedAt + 10_000
    );
    const merged = mergeRuntimeStateWithStoppingTombstones([failed, other], [tombstone]);

    expect(merged).toHaveLength(2);
    expect(merged.find((runtime) => runtime.sid === failed.sid)?.state).toBe("stopping");
    expect(merged.find((runtime) => runtime.sid === other.sid)).toEqual(other);
  });

  it("does not activate a failed first tombstone write and persists again on retry", async () => {
    let stopping = false;
    let attempts = 0;
    const activate = vi.fn(() => {
      stopping = true;
    });
    const persist = vi.fn(async () => {
      attempts += 1;

      if (attempts === 1) {
        throw new Error("storage unavailable");
      }
    });

    await expect(persistDurableStopTombstone({ activate, persist })).rejects.toThrow(
      /storage unavailable/
    );
    expect(stopping).toBe(false);
    expect(activate).not.toHaveBeenCalled();

    await persistDurableStopTombstone({ activate, persist });
    expect(stopping).toBe(true);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("writes a serialized stopping row before activating the in-memory marker", async () => {
    const active = createRuntime("active") as PersistedActiveRuntime;
    const stopRequestedAt = active.startedAt + 1_000;
    let activated = false;
    const storageSet = vi.fn(async (snapshot: ReturnType<typeof createRuntimeStateSnapshot>) => {
      expect(activated).toBe(false);
      expect(snapshot.sessions[0]).toMatchObject({
        sid: active.sid,
        state: "stopping",
        stopRequestedAt
      });
    });

    await persistDurableStopTombstone({
      persist: () =>
        storageSet(
          createRuntimeStateSnapshot([
            createStoppingRuntimeTombstone(active, stopRequestedAt, stopRequestedAt + 10_000)
          ])
        ),
      activate: () => {
        activated = true;
      }
    });

    expect(storageSet).toHaveBeenCalledTimes(1);
    expect(activated).toBe(true);
  });

  it("closes capture synchronously while the stopping tombstone write is deferred", async () => {
    const captureFence = createVolatileCaptureFence();
    const checkpoint = createDeferred();
    const teardown = vi.fn();
    const persistStopped = vi.fn();
    const stopTask = runDurableRuntimeStopWorkflow({
      captureFence,
      persistStopping: () => checkpoint.promise,
      teardownSteps: [teardown],
      persistStopped
    });

    expect(isVolatileCaptureOpen(captureFence)).toBe(false);
    const writes = vi.fn(async () => "hash");
    const representatives = ["event", "screenshot", "dom", "storage", "indexeddb", "video"];
    const blockedResults = await Promise.all(
      representatives.map(() => runVolatileCaptureOperation(captureFence, writes))
    );

    expect(blockedResults).toEqual(representatives.map(() => null));
    expect(writes).not.toHaveBeenCalled();
    expect(teardown).not.toHaveBeenCalled();
    checkpoint.resolve(undefined);
    await stopTask;
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(persistStopped).toHaveBeenCalledTimes(1);
  });

  it("keeps capture blocked and does not begin teardown when the tombstone write fails", async () => {
    const captureFence = createVolatileCaptureFence();
    const teardown = vi.fn();
    const persistStopped = vi.fn();

    await expect(
      runDurableRuntimeStopWorkflow({
        captureFence,
        persistStopping: () => Promise.reject(new Error("checkpoint failed")),
        teardownSteps: [teardown],
        persistStopped
      })
    ).rejects.toThrow(/checkpoint failed/);

    expect(isVolatileCaptureOpen(captureFence)).toBe(false);
    expect(teardown).not.toHaveBeenCalled();
    expect(persistStopped).not.toHaveBeenCalled();
  });

  it("drops an in-flight capture result when stop closes the fence", async () => {
    const captureFence = createVolatileCaptureFence();
    const captureResult = createDeferred<string>();
    const write = vi.fn(() => captureResult.promise);
    const inFlight = runVolatileCaptureOperation(captureFence, write);

    expect(write).toHaveBeenCalledTimes(1);
    await expect(
      runDurableRuntimeStopWorkflow({
        captureFence,
        persistStopping: () => Promise.reject(new Error("checkpoint failed")),
        teardownSteps: [],
        persistStopped: vi.fn()
      })
    ).rejects.toThrow(/checkpoint failed/);

    captureResult.resolve("orphaned-hash");
    await expect(inFlight).resolves.toBeNull();
    expect(isVolatileCaptureOpen(captureFence)).toBe(false);
  });

  it("opens a fresh fence only for a newly authorized active runtime", async () => {
    const blockedFence = createVolatileCaptureFence();
    await expect(
      runDurableRuntimeStopWorkflow({
        captureFence: blockedFence,
        persistStopping: () => Promise.reject(new Error("checkpoint failed")),
        teardownSteps: [],
        persistStopped: vi.fn()
      })
    ).rejects.toThrow(/checkpoint failed/);
    expect(isVolatileCaptureOpen(blockedFence)).toBe(false);

    const restored = evaluateActiveRuntimeRestoration(
      createRuntime("active") as PersistedActiveRuntime,
      { id: 7, url: "https://example.test/restored" },
      Date.parse("2026-01-01T00:30:00.000Z")
    );
    expect(restored.allowed).toBe(true);

    const freshFence = createVolatileCaptureFence();
    const write = vi.fn(async () => "restored-hash");
    await expect(runVolatileCaptureOperation(freshFence, write)).resolves.toBe("restored-hash");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1, 2])(
    "keeps the durable stopping state when teardown crash point %i aborts",
    async (crashPoint) => {
      let durableState: PersistedRuntime["state"] = "active";
      const teardownSteps = [0, 1, 2].map((index) => async () => {
        if (index === crashPoint) {
          throw new Error(`crash-${index}`);
        }
      });

      await expect(
        runDurableRuntimeStopWorkflow({
          captureFence: createVolatileCaptureFence(),
          persistStopping: () => {
            durableState = "stopping";
          },
          teardownSteps,
          persistStopped: () => {
            durableState = "stopped";
          }
        })
      ).rejects.toThrow(`crash-${crashPoint}`);

      expect(durableState).toBe("stopping");
    }
  );

  it("persists stopped after teardown and can retry a failed final checkpoint", async () => {
    const order: string[] = [];
    let durableState: PersistedRuntime["state"] = "active";
    let finalAttempts = 0;
    const persistStopped = async () => {
      finalAttempts += 1;

      if (finalAttempts === 1) {
        throw new Error("final checkpoint failed");
      }

      durableState = "stopped";
      order.push("stopped");
    };

    await expect(
      runDurableRuntimeStopWorkflow({
        captureFence: createVolatileCaptureFence(),
        persistStopping: () => {
          durableState = "stopping";
          order.push("stopping");
        },
        teardownSteps: [
          () => {
            order.push("teardown");
          }
        ],
        persistStopped
      })
    ).rejects.toThrow(/final checkpoint failed/);
    expect(durableState).toBe("stopping");

    await persistStopped();
    expect(durableState).toBe("stopped");
    expect(order).toEqual(["stopping", "teardown", "stopped"]);
  });

  it("stops an offscreen recorder that survived the stopping checkpoint before purge", async () => {
    const order: string[] = [];

    await recoverStoppingRuntimeFailClosed({
      getScreenRecordingStatus: async () => {
        order.push("status");
        return {
          active: true,
          recordingId: "VR-stopping",
          mime: "video/webm"
        };
      },
      stopScreenRecording: async (status) => {
        order.push(`stop:${status.recordingId}`);
      },
      purge: async () => {
        order.push("purge");
      }
    });

    expect(order).toEqual(["status", "stop:VR-stopping", "purge"]);
  });

  it("still purges when stopping an orphaned offscreen recorder fails", async () => {
    const purge = vi.fn();

    await expect(
      recoverStoppingRuntimeFailClosed({
        getScreenRecordingStatus: () => ({
          active: true,
          recordingId: "VR-stopping",
          mime: "video/webm"
        }),
        stopScreenRecording: () => Promise.reject(new Error("recorder stop failed")),
        purge
      })
    ).rejects.toThrow(/recorder stop failed/);
    expect(purge).toHaveBeenCalledTimes(1);
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

  it("advances stale recorder counters to the pipeline high-water", () => {
    const runtime = createRuntime() as PersistedActiveRuntime;
    const merged = mergeRuntimeCountersWithSequenceWatermark(runtime.counters, {
      event: 47,
      action: 9
    });

    expect(merged.recorderEventSequence).toBe(47);
    expect(merged.recorderActionSequence).toBe(9);
    expect(merged.eventCount).toBe(runtime.counters.eventCount);

    const recorder = new WebBlackboxRecorder(createConfig());
    recorder.restoreSequenceState({
      event: merged.recorderEventSequence,
      action: merged.recorderActionSequence
    });
    const next = recorder.ingest({
      source: "content",
      rawType: "click",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: runtime.startedAt + 1,
      mono: runtime.startedAt + 1,
      payload: { selector: "button" }
    });
    expect(next.event?.id).toBe("E-00000048");
    expect(next.event?.ref?.act).toBe("A-000010");
  });

  it("rebuilds restart-spanning video hashes without writing them to chrome.storage", () => {
    const hashBeforeRestart = "a".repeat(64);
    const hashAfterRestart = "b".repeat(64);
    const hashes = restoreScreenRecordingChunkHashes(1, [
      { index: 0, hash: hashBeforeRestart },
      { index: 1, hash: hashAfterRestart }
    ]);

    const endEvent = {
      type: "screen.recording.end",
      data: {
        chunks: compactScreenRecordingChunkHashes(hashes)
      }
    };
    expect(endEvent.data.chunks).toEqual([hashBeforeRestart, hashAfterRestart]);

    const runtime = createRuntime() as PersistedActiveRuntime;
    runtime.screenRecording = {
      recordingId: "VR-restart",
      startedAt: runtime.startedAt,
      startedMono: runtime.startedAt,
      mime: "video/webm",
      chunkCount: 1,
      sizeBytes: 10
    };
    const serialized = JSON.stringify(createRuntimeStateSnapshot([runtime]));
    expect(serialized).not.toContain(hashBeforeRestart);
    expect(serialized).not.toContain(hashAfterRestart);
    expect(serialized).not.toContain('"chunks"');
  });

  it("reconciles an ahead-of-pipeline MV3 chunk count to durable references", () => {
    expect(
      deriveDurableScreenRecordingChunkCount([
        { index: 0, hash: "a".repeat(64) },
        { index: 2, hash: "b".repeat(64) }
      ])
    ).toBe(3);
    expect(deriveDurableScreenRecordingChunkCount([])).toBe(0);
    expect(() =>
      deriveDurableScreenRecordingChunkCount([{ index: -1, hash: "c".repeat(64) }])
    ).toThrow(/durable.*range/i);

    const persisted = {
      recordingId: "VR-reconcile",
      startedAt: 1,
      startedMono: 1,
      mime: "video/webm",
      chunkCount: 4,
      sizeBytes: 100
    };
    const reconciled = reconcileScreenRecordingResumeState(persisted, {
      recordingId: persisted.recordingId,
      chunks: [{ index: 0, hash: "d".repeat(64), size: 10 }]
    }).screenRecording;
    expect(reconciled?.chunkCount).toBe(1);
    expect(reconciled?.sizeBytes).toBe(10);
    expect(reconcileScreenRecordingResumeState(persisted, undefined)).toEqual({
      screenRecording: undefined,
      chunks: undefined
    });
  });

  it("validates the offscreen recorder liveness handshake", () => {
    expect(normalizeOffscreenScreenRecordingStatus({ active: false })).toEqual({
      active: false
    });
    expect(
      normalizeOffscreenScreenRecordingStatus({
        active: true,
        recordingId: "VR-live",
        mime: "video/webm"
      })
    ).toEqual({ active: true, recordingId: "VR-live", mime: "video/webm" });
    expect(() =>
      normalizeOffscreenScreenRecordingStatus({ active: true, recordingId: "", extra: true })
    ).toThrow(/invalid offscreen/i);
  });

  it("preserves durable partial video segments when recorder liveness is lost", () => {
    const persisted = {
      recordingId: "VR-partial",
      startedAt: 10,
      startedMono: 10,
      mime: "video/webm",
      chunkCount: 2,
      sizeBytes: 99
    };
    const resumeState = {
      sequenceWatermark: { event: 2, action: 0 },
      screenRecordings: [
        {
          recordingId: persisted.recordingId,
          chunks: [
            { index: 0, hash: "a".repeat(64), size: 11 },
            { index: 1, hash: "b".repeat(64), size: 13 }
          ]
        }
      ]
    };

    expect(
      buildInterruptedScreenRecordingRecoveries({
        persisted,
        resumeState,
        status: { active: false },
        claimedRecordingId: undefined
      })
    ).toEqual([
      expect.objectContaining({
        recordingId: persisted.recordingId,
        mime: "video/webm",
        sizeBytes: 24,
        chunks: resumeState.screenRecordings[0]?.chunks
      })
    ]);
    expect(
      buildInterruptedScreenRecordingRecoveries({
        persisted,
        resumeState,
        status: {
          active: true,
          recordingId: persisted.recordingId,
          mime: "video/webm"
        },
        claimedRecordingId: persisted.recordingId
      })
    ).toEqual([]);
    expect(
      buildInterruptedScreenRecordingRecoveries({
        persisted: undefined,
        resumeState: { sequenceWatermark: { event: 0, action: 0 }, screenRecordings: [] },
        status: { active: true, recordingId: "VR-unclaimed", mime: "video/webm" },
        claimedRecordingId: undefined
      })
    ).toEqual([
      expect.objectContaining({
        recordingId: "VR-unclaimed",
        mime: "video/webm",
        chunks: [],
        sizeBytes: 0
      })
    ]);
  });
});

describe("MV3 cleanup scheduling", () => {
  it("retains a failed stopping recovery and removes it after a bounded retry succeeds", async () => {
    let now = 1_000;
    let purgeShouldFail = true;
    const tombstone = createRuntime("stopping") as Extract<PersistedRuntime, { state: "stopping" }>;
    const retained = new Map([[tombstone.sid, tombstone]]);
    const scheduler = new RuntimeCleanupScheduler({
      alarms: {
        create: vi.fn(),
        clear: vi.fn().mockResolvedValue(true)
      },
      now: () => now,
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      retryDelayMs: 100,
      onDue: async (sid) => {
        const pending = retained.get(sid);

        if (!pending) {
          return;
        }

        await recoverStoppingRuntimeFailClosed({
          getScreenRecordingStatus: () => ({ active: false }),
          stopScreenRecording: vi.fn(),
          purge: async () => {
            if (purgeShouldFail) {
              throw new Error("purge failed");
            }
          }
        });
        retained.delete(sid);
      }
    });
    const alarmName = createRuntimeCleanupAlarmName(tombstone.sid);

    await scheduler.schedule(tombstone.sid, 1_100);
    now = 1_101;
    await expect(scheduler.handleAlarm(alarmName)).rejects.toThrow(/purge failed/);
    expect(retained.has(tombstone.sid)).toBe(true);

    purgeShouldFail = false;
    now = 1_202;
    await scheduler.handleAlarm(alarmName);
    expect(retained.has(tombstone.sid)).toBe(false);
  });

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

  it("re-arms cleanup after a transient due-time flush failure", async () => {
    let now = 5_000;
    const sessions = new Set(["S-1767225600001-retry"]);
    const alarmCreate = vi.fn();
    const onDue = vi
      .fn<(sid: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("transient flush failure"))
      .mockImplementationOnce(async (sid) => {
        sessions.delete(sid);
      });
    const scheduler = new RuntimeCleanupScheduler({
      alarms: { create: alarmCreate, clear: vi.fn().mockResolvedValue(true) },
      now: () => now,
      retryDelayMs: 100,
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      onDue
    });

    await expect(scheduler.schedule("S-1767225600001-retry", 4_999)).rejects.toThrow(
      "transient flush failure"
    );
    expect(sessions.has("S-1767225600001-retry")).toBe(true);
    expect(scheduler.getDeadline("S-1767225600001-retry")).toBe(5_100);
    expect(alarmCreate).toHaveBeenLastCalledWith(
      createRuntimeCleanupAlarmName("S-1767225600001-retry"),
      { when: 5_100 }
    );

    now = 5_101;
    await scheduler.handleAlarm(createRuntimeCleanupAlarmName("S-1767225600001-retry"));
    expect(sessions.has("S-1767225600001-retry")).toBe(false);
    expect(onDue).toHaveBeenCalledTimes(2);
  });
});

describe("active runtime restoration transaction", () => {
  it("keeps a survived recording provisional until the final activation commit", async () => {
    const order: string[] = [];
    const runtime = {
      activationState: "starting" as const,
      captureFence: createVolatileCaptureFence(),
      stopping: false,
      screenRecording: {
        provisional: isRuntimeActivationProvisional("starting")
      }
    };
    const cleanupRuntime = vi.fn();
    const result = await runActiveRuntimeRestorationTransaction({
      startPipeline: () => {
        order.push("pipeline");
      },
      prepareRuntime: () => {
        order.push("prepare");
        return runtime;
      },
      registerRuntime: () => {
        order.push("register");
      },
      completeRuntime: () => {
        expect(isRuntimeCaptureAdmitted(runtime.activationState)).toBe(false);
        expect(runtime.screenRecording.provisional).toBe(true);
        order.push("interrupted-events-flushed");
      },
      activateRuntime: () => {
        commitRestoredRuntimeActivation(runtime, {
          currentByTab: true,
          currentBySid: true
        });
        expect(isRuntimeCaptureAdmitted(runtime.activationState)).toBe(true);
        expect(runtime.screenRecording.provisional).toBe(false);
        order.push("commit-active");
      },
      cleanupPipeline: vi.fn(),
      cleanupRuntime
    });

    expect(result).toEqual({ kind: "restored", runtime });
    order.push("notify-active");
    expect(order).toEqual([
      "pipeline",
      "prepare",
      "register",
      "interrupted-events-flushed",
      "commit-active",
      "notify-active"
    ]);
    expect(cleanupRuntime).not.toHaveBeenCalled();
  });

  it.each(["start", "resume"] as const)(
    "purges pipeline-only state when %s fails before runtime registration",
    async (fault) => {
      const cleanupPipeline = vi.fn(async () => undefined);
      const cleanupRuntime = vi.fn(async () => undefined);
      const result = await runActiveRuntimeRestorationTransaction({
        startPipeline: async () => {
          if (fault === "start") {
            throw new Error("start failed after pipeline creation");
          }
        },
        prepareRuntime: async () => {
          throw new Error("resume state failed");
        },
        registerRuntime: vi.fn(),
        completeRuntime: vi.fn(),
        activateRuntime: vi.fn(),
        cleanupPipeline,
        cleanupRuntime
      });

      expect(result).toMatchObject({ kind: "failed-cleaned", phase: "pipeline" });
      expect(cleanupPipeline).toHaveBeenCalledOnce();
      expect(cleanupRuntime).not.toHaveBeenCalled();
    }
  );

  it.each(["content", "cdp", "recording", "flush"] as const)(
    "removes registered state when the %s restoration stage fails",
    async (fault) => {
      const runtime = { sid: "failed", tabId: 7 };
      const other = { sid: "other", tabId: 8 };
      const sessionsByTab = new Map([[other.tabId, other] as const]);
      const sessionsBySid = new Map([[other.sid, other] as const]);
      const cleanupPipeline = vi.fn(async () => undefined);
      const cleanupRuntime = vi.fn(async (failed: typeof runtime) => {
        deleteMapEntryIfSame(sessionsByTab, failed.tabId, failed);
        deleteMapEntryIfSame(sessionsBySid, failed.sid, failed);
      });
      const activateRuntime = vi.fn();
      const stages = ["content", "cdp", "recording", "flush"] as const;
      const result = await runActiveRuntimeRestorationTransaction({
        startPipeline: vi.fn(async () => undefined),
        prepareRuntime: vi.fn(async () => runtime),
        registerRuntime: (restored) => {
          sessionsByTab.set(restored.tabId, restored);
          sessionsBySid.set(restored.sid, restored);
        },
        completeRuntime: async () => {
          for (const stage of stages) {
            if (stage === fault) {
              throw new Error(`${stage} failed`);
            }
          }
        },
        activateRuntime,
        cleanupPipeline,
        cleanupRuntime
      });

      expect(result).toMatchObject({ kind: "failed-cleaned", phase: "runtime" });
      expect(cleanupRuntime).toHaveBeenCalledOnce();
      expect(cleanupPipeline).not.toHaveBeenCalled();
      expect(activateRuntime).not.toHaveBeenCalled();
      expect(sessionsByTab.has(runtime.tabId)).toBe(false);
      expect(sessionsBySid.has(runtime.sid)).toBe(false);
      expect(sessionsByTab.get(other.tabId)).toBe(other);
      expect(sessionsBySid.get(other.sid)).toBe(other);
    }
  );

  it("cleans exactly once without publishing when the activation identity is lost", async () => {
    const runtime = {
      activationState: "starting" as const,
      captureFence: createVolatileCaptureFence(),
      stopping: false,
      screenRecording: { provisional: true }
    };
    const publishActive = vi.fn();
    const cleanupRuntime = vi.fn();
    const result = await runActiveRuntimeRestorationTransaction({
      startPipeline: vi.fn(),
      prepareRuntime: () => runtime,
      registerRuntime: vi.fn(),
      completeRuntime: vi.fn(),
      activateRuntime: () => {
        commitRestoredRuntimeActivation(runtime, {
          currentByTab: true,
          currentBySid: false
        });
      },
      cleanupPipeline: vi.fn(),
      cleanupRuntime
    });

    if (result.kind === "restored") {
      publishActive();
    }

    expect(result).toMatchObject({ kind: "failed-cleaned", phase: "runtime" });
    expect(runtime.activationState).toBe("starting");
    expect(runtime.screenRecording.provisional).toBe(true);
    expect(cleanupRuntime).toHaveBeenCalledOnce();
    expect(publishActive).not.toHaveBeenCalled();
  });

  it.each([
    ["tab registry", { currentByTab: false, currentBySid: true }, false, "starting"],
    ["sid registry", { currentByTab: true, currentBySid: false }, false, "starting"],
    ["capture fence", { currentByTab: true, currentBySid: true }, true, "starting"],
    ["activation state", { currentByTab: true, currentBySid: true }, false, "active"]
  ] as const)("rejects activation after losing the %s invariant", (_, identity, blocked, state) => {
    const runtime: {
      activationState: "starting" | "active";
      captureFence: { blocked: boolean };
      stopping: boolean;
      screenRecording: { provisional: boolean };
    } = {
      activationState: state,
      captureFence: createVolatileCaptureFence(blocked),
      stopping: false,
      screenRecording: { provisional: true }
    };

    expect(() => commitRestoredRuntimeActivation(runtime, identity)).toThrow(
      "lost its provisional activation identity"
    );
    expect(runtime.activationState).toBe(state);
    expect(runtime.screenRecording.provisional).toBe(true);
  });

  it("reports purge failure without replaying restoration cleanup", async () => {
    const purgeError = new Error("purge failed");
    const cleanupPipeline = vi.fn(async () => {
      throw purgeError;
    });
    const result = await runActiveRuntimeRestorationTransaction({
      startPipeline: vi.fn(async () => undefined),
      prepareRuntime: async () => {
        throw new Error("resume failed");
      },
      registerRuntime: vi.fn(),
      completeRuntime: vi.fn(),
      activateRuntime: vi.fn(),
      cleanupPipeline,
      cleanupRuntime: vi.fn()
    });

    expect(result).toMatchObject({
      kind: "failed-cleaned",
      phase: "pipeline",
      cleanupError: purgeError
    });
    expect(cleanupPipeline).toHaveBeenCalledOnce();
  });

  it("persists stopping before cleanup and clears it only after purge", async () => {
    const order: string[] = [];

    await runDurableFailedRuntimeCleanup({
      persistStopping: () => {
        order.push("stopping");
      },
      cleanup: () => {
        order.push("purge");
      },
      clearStopping: () => {
        order.push("clear");
      }
    });

    expect(order).toEqual(["stopping", "purge", "clear"]);
  });

  it.each(["checkpoint", "purge", "clear"] as const)(
    "preserves the durable cleanup boundary when %s fails",
    async (fault) => {
      const order: string[] = [];
      const task = runDurableFailedRuntimeCleanup({
        persistStopping: () => {
          order.push("stopping");
          if (fault === "checkpoint") {
            throw new Error("checkpoint failed");
          }
        },
        cleanup: () => {
          order.push("purge");
          if (fault === "purge") {
            throw new Error("purge failed");
          }
        },
        clearStopping: () => {
          order.push("clear");
          if (fault === "clear") {
            throw new Error("clear failed");
          }
        }
      });

      await expect(task).rejects.toThrow(`${fault} failed`);
      expect(order).toEqual(
        fault === "checkpoint"
          ? ["stopping"]
          : fault === "purge"
            ? ["stopping", "purge"]
            : ["stopping", "purge", "clear"]
      );
    }
  );

  it("does not delete a replacement runtime that won an identity race", () => {
    const failed = { sid: "same", tabId: 7, generation: 1 };
    const replacement = { sid: "same", tabId: 7, generation: 2 };
    const byTab = new Map([[7, replacement]]);
    const bySid = new Map([["same", replacement]]);

    expect(isMapEntrySame(byTab, failed.tabId, failed)).toBe(false);
    expect(deleteMapEntryIfSame(byTab, failed.tabId, failed)).toBe(false);
    expect(deleteMapEntryIfSame(bySid, failed.sid, failed)).toBe(false);
    expect(byTab.get(7)).toBe(replacement);
    expect(bySid.get("same")).toBe(replacement);
  });

  it("disposes runtime listeners before detach can target a same-tab replacement", async () => {
    const replacement = { tabId: 7, generation: 2 };
    const byTab = new Map([[7, replacement]]);
    let detachListenerActive = true;
    const stopReplacement = vi.fn();

    await disposeListenersBeforeTeardown(
      [
        () => {
          detachListenerActive = false;
        }
      ],
      () => {
        if (detachListenerActive) {
          stopReplacement();
        }
      }
    );

    expect(detachListenerActive).toBe(false);
    expect(stopReplacement).not.toHaveBeenCalled();
    expect(byTab.get(7)).toBe(replacement);
  });
});

describe("runtime start coordination", () => {
  it("admits capture only after the active commit", () => {
    expect(isRuntimeCaptureAdmitted("starting")).toBe(false);
    expect(isRuntimeCaptureAdmitted("active")).toBe(true);
  });

  it("coalesces only identical concurrent starts and allows a later start", async () => {
    const coordinator = new RuntimeStartCoordinator();
    let release!: () => void;
    const firstStart = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const first = coordinator.run(7, "lite:none:false", firstStart);
    const duplicate = coordinator.run(7, "lite:none:false", firstStart);
    await Promise.resolve();
    expect(firstStart).toHaveBeenCalledOnce();
    expect(duplicate).toBe(first);
    release();
    await first;

    await coordinator.run(
      7,
      "lite:none:false",
      firstStart.mockImplementation(async () => undefined)
    );
    expect(firstStart).toHaveBeenCalledTimes(2);
  });

  it("cancels and serializes a different concurrent start for the same tab", async () => {
    const coordinator = new RuntimeStartCoordinator();
    const order: string[] = [];
    let release!: () => void;

    const first = coordinator.run(7, "lite:none:false", async (token) => {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      token.assertActive();
      order.push("first:commit");
    });
    await Promise.resolve();
    const second = coordinator.run(7, "full:both:false", async () => {
      order.push("second:start");
    });

    release();
    const [firstResult, secondResult] = await Promise.allSettled([first, second]);

    expect(firstResult).toMatchObject({
      status: "rejected",
      reason: expect.any(RuntimeStartCancelledError)
    });
    expect(secondResult).toEqual({ status: "fulfilled", value: undefined });
    expect(order).toEqual(["first:start", "second:start"]);
  });

  it("cancels an in-flight start synchronously for stop or tab removal", async () => {
    const coordinator = new RuntimeStartCoordinator();
    let release!: () => void;
    const task = coordinator.run(7, "lite:none:true", async (token) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      token.assertActive();
    });
    await Promise.resolve();

    coordinator.cancel(7);
    release();

    await expect(task).rejects.toBeInstanceOf(RuntimeStartCancelledError);
  });
});

describe("provisional runtime start transaction", () => {
  it("starts requested recording before the active commit", async () => {
    const token = new RuntimeStartToken();
    const startRecording = vi.fn().mockResolvedValue(undefined);
    const commit = vi.fn(() => {
      expect(startRecording).toHaveBeenCalledOnce();
    });

    await runProvisionalRuntimeStartTransaction({
      token,
      checkpointStopping: () => ({ sid: "new" }),
      startPipeline: () => undefined,
      stopExisting: () => undefined,
      prepareRuntime: () => ({ sid: "new" }),
      registerRuntime: () => undefined,
      completeRuntime: startRecording,
      commitRuntime: commit,
      cleanupPipeline: () => undefined,
      cleanupRuntime: () => undefined
    });

    expect(commit).toHaveBeenCalledOnce();
  });

  it("rolls back instead of committing when requested recording fails", async () => {
    const token = new RuntimeStartToken();
    const commit = vi.fn();
    const cleanupRuntime = vi.fn();

    await expect(
      runProvisionalRuntimeStartTransaction({
        token,
        checkpointStopping: () => ({ sid: "new" }),
        startPipeline: () => undefined,
        stopExisting: () => undefined,
        prepareRuntime: () => ({ sid: "new" }),
        registerRuntime: () => undefined,
        completeRuntime: () => {
          throw new Error("screen recording failed");
        },
        commitRuntime: commit,
        cleanupPipeline: () => undefined,
        cleanupRuntime
      })
    ).rejects.toThrow("screen recording failed");

    expect(commit).not.toHaveBeenCalled();
    expect(cleanupRuntime).toHaveBeenCalledOnce();
  });

  it("rolls back a registered runtime when reload fails", async () => {
    const token = new RuntimeStartToken();
    const commit = vi.fn();
    const cleanupRuntime = vi.fn();

    await expect(
      runProvisionalRuntimeStartTransaction({
        token,
        checkpointStopping: () => ({ sid: "new" }),
        startPipeline: () => undefined,
        stopExisting: () => undefined,
        prepareRuntime: () => ({ sid: "new" }),
        registerRuntime: () => undefined,
        completeRuntime: async () => {
          await Promise.resolve();
          throw new Error("reload failed");
        },
        commitRuntime: commit,
        cleanupPipeline: () => undefined,
        cleanupRuntime
      })
    ).rejects.toThrow("reload failed");

    expect(commit).not.toHaveBeenCalled();
    expect(cleanupRuntime).toHaveBeenCalledOnce();
  });

  it("does not run destructive cleanup when the durable checkpoint itself fails", async () => {
    const token = new RuntimeStartToken();
    const cleanupPipeline = vi.fn();
    const cleanupRuntime = vi.fn();

    await expect(
      runProvisionalRuntimeStartTransaction({
        token,
        checkpointStopping: () => {
          throw new Error("checkpoint failed");
        },
        startPipeline: () => undefined,
        stopExisting: () => undefined,
        prepareRuntime: () => ({ sid: "new" }),
        registerRuntime: () => undefined,
        completeRuntime: () => undefined,
        commitRuntime: () => undefined,
        cleanupPipeline,
        cleanupRuntime
      })
    ).rejects.toThrow("checkpoint failed");

    expect(cleanupPipeline).not.toHaveBeenCalled();
    expect(cleanupRuntime).not.toHaveBeenCalled();
  });

  it("commits active state only after all provisional stages complete", async () => {
    const order: string[] = [];
    const runtime = { sid: "new" };
    const coordinator = new RuntimeStartCoordinator();

    await coordinator.run(7, "lite:none:true", async (token) => {
      await runProvisionalRuntimeStartTransaction({
        token,
        checkpointStopping: () => {
          order.push("checkpoint");
          return { sid: "new", state: "stopping" as const };
        },
        startPipeline: () => {
          order.push("pipeline");
        },
        stopExisting: () => {
          order.push("stop-existing");
        },
        prepareRuntime: () => {
          order.push("prepare");
          return runtime;
        },
        registerRuntime: () => {
          order.push("register");
        },
        completeRuntime: () => {
          order.push("complete");
        },
        commitRuntime: () => {
          order.push("commit-active");
        },
        cleanupPipeline: () => {
          order.push("cleanup-pipeline");
        },
        cleanupRuntime: () => {
          order.push("cleanup-runtime");
        }
      });
    });

    expect(order).toEqual([
      "checkpoint",
      "pipeline",
      "stop-existing",
      "prepare",
      "register",
      "complete",
      "commit-active"
    ]);
  });

  it.each([
    ["pipeline", "pipeline"],
    ["stop-existing", "pipeline"],
    ["prepare", "pipeline"],
    ["complete", "runtime"],
    ["commit", "runtime"]
  ] as const)("cleans the %s failure through the %s path", async (fault, cleanup) => {
    const calls: string[] = [];
    const token = new RuntimeStartToken();
    const fail = (stage: typeof fault) => {
      if (fault === stage) {
        throw new Error(`${stage} failed`);
      }
    };

    const task = runProvisionalRuntimeStartTransaction({
      token,
      checkpointStopping: () => ({ sid: "new" }),
      startPipeline: () => fail("pipeline"),
      stopExisting: () => fail("stop-existing"),
      prepareRuntime: () => {
        fail("prepare");
        return { sid: "new" };
      },
      registerRuntime: () => undefined,
      completeRuntime: () => fail("complete"),
      commitRuntime: () => fail("commit"),
      cleanupPipeline: () => {
        calls.push("pipeline");
      },
      cleanupRuntime: () => {
        calls.push("runtime");
      }
    });

    await expect(task).rejects.toThrow(`${fault} failed`);
    expect(calls).toEqual([cleanup]);
  });

  it("routes cancellation after checkpoint through provisional cleanup", async () => {
    const coordinator = new RuntimeStartCoordinator();
    const cleanup = vi.fn();

    const task = coordinator.run(7, "lite:none:false", async (token) => {
      await runProvisionalRuntimeStartTransaction({
        token,
        checkpointStopping: () => ({ sid: "new" }),
        startPipeline: () => {
          coordinator.cancel(7);
        },
        stopExisting: () => undefined,
        prepareRuntime: () => ({ sid: "new" }),
        registerRuntime: () => undefined,
        completeRuntime: () => undefined,
        commitRuntime: () => undefined,
        cleanupPipeline: cleanup,
        cleanupRuntime: () => undefined
      });
    });

    await expect(task).rejects.toBeInstanceOf(RuntimeStartCancelledError);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("reports both the start and cleanup failures", async () => {
    const token = new RuntimeStartToken();
    const task = runProvisionalRuntimeStartTransaction({
      token,
      checkpointStopping: () => ({ sid: "new" }),
      startPipeline: () => {
        throw new Error("pipeline failed");
      },
      stopExisting: () => undefined,
      prepareRuntime: () => ({ sid: "new" }),
      registerRuntime: () => undefined,
      completeRuntime: () => undefined,
      commitRuntime: () => undefined,
      cleanupPipeline: () => {
        throw new Error("cleanup failed");
      },
      cleanupRuntime: () => undefined
    });

    await expect(task).rejects.toMatchObject({
      name: "AggregateError",
      errors: [expect.any(Error), expect.any(Error)]
    });
  });
});
