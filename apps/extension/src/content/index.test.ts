// @vitest-environment jsdom

import { DEFAULT_CAPTURE_POLICY } from "@webblackbox/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const runtimeListeners: Array<
    (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => unknown
  > = [];
  const portMessageListeners: Array<(message: unknown) => void> = [];
  const portDisconnectListeners: Array<() => void> = [];
  const portMessages: unknown[] = [];
  const sentMessages: unknown[] = [];
  const agentStates: unknown[] = [];
  let flushEvent: unknown | null = null;
  let flushCalls = 0;
  let freezeCalls = 0;
  let quiesceCalls = 0;
  let prepareStopCalls = 0;
  let resolvePrepareStop: (() => void) | null = null;
  let agentCreationFailures = 1;
  let agentCreationCalls = 0;
  let agentOptions: {
    emitBatch(events: unknown[], activationId: string): void;
    onInjectedBridgeArmed?: (activationId: string) => void;
  } | null = null;
  let activationSequence = 0;
  let controllerRevision = 0;
  let controllerPhase: "inactive" | "active" | "drained" = "inactive";
  let controllerActivationId: string | null = null;
  const port = {
    name: "webblackbox:content",
    onMessage: {
      addListener(listener: (message: unknown) => void) {
        portMessageListeners.push(listener);
      },
      removeListener(listener: (message: unknown) => void) {
        const index = portMessageListeners.indexOf(listener);
        if (index >= 0) portMessageListeners.splice(index, 1);
      }
    },
    onDisconnect: {
      addListener(listener: () => void) {
        portDisconnectListeners.push(listener);
      },
      removeListener(listener: () => void) {
        const index = portDisconnectListeners.indexOf(listener);
        if (index >= 0) portDisconnectListeners.splice(index, 1);
      }
    },
    postMessage(message: unknown) {
      portMessages.push(message);
    },
    disconnect() {
      for (const listener of [...portDisconnectListeners]) listener();
    }
  };
  const agent = {
    setRecordingStatus(next: unknown) {
      agentStates.push(next);
    },
    flush() {
      flushCalls += 1;
      if (flushEvent && agentOptions) {
        agentOptions.emitBatch([flushEvent], state.currentActivationId());
        flushEvent = null;
      }
    },
    freezeOrdinaryCapture() {
      freezeCalls += 1;
    },
    quiesceOrdinaryCapture() {
      quiesceCalls += 1;
    },
    mergeInjectedDirectReplay() {
      return { confirmed: true, conflict: false, replayedEvents: 0 };
    },
    prepareStopCapture() {
      prepareStopCalls += 1;
      return new Promise<{
        expectedArtifacts: [];
        emittedArtifacts: [];
        omittedArtifacts: [];
        degraded: false;
        degradationReason: null;
      }>((resolve) => {
        resolvePrepareStop = () =>
          resolve({
            expectedArtifacts: [],
            emittedArtifacts: [],
            omittedArtifacts: [],
            degraded: false,
            degradationReason: null
          });
      });
    },
    emitMarker() {},
    setIndicatorState() {},
    dispose() {}
  };

  return {
    runtimeListeners,
    portMessageListeners,
    portMessages,
    sentMessages,
    agentStates,
    port,
    agent,
    setFlushEvent(event: unknown) {
      flushEvent = event;
    },
    get flushCalls() {
      return flushCalls;
    },
    get freezeCalls() {
      return freezeCalls;
    },
    get quiesceCalls() {
      return quiesceCalls;
    },
    get prepareStopCalls() {
      return prepareStopCalls;
    },
    get agentCreationCalls() {
      return agentCreationCalls;
    },
    createAgent(options: typeof agentOptions) {
      agentCreationCalls += 1;
      if (agentCreationFailures > 0) {
        agentCreationFailures -= 1;
        throw new Error("content agent unavailable once");
      }
      agentOptions = options;
      return agent;
    },
    finishPrepareStop() {
      resolvePrepareStop?.();
      resolvePrepareStop = null;
    },
    get agentOptions() {
      return agentOptions;
    },
    setAgentOptions(options: typeof agentOptions) {
      agentOptions = options;
    },
    nextActivationId() {
      activationSequence += 1;
      return `a1_${activationSequence.toString(16).padStart(64, "0")}`;
    },
    currentActivationId() {
      return `a1_${activationSequence.toString(16).padStart(64, "0")}`;
    },
    controllerHint() {
      return {
        secret: "f".repeat(64),
        moduleNonce: `m1_${"e".repeat(64)}`,
        revision: controllerRevision,
        phase: controllerPhase,
        activationId: controllerActivationId
      };
    },
    controlMainWorld(operation: "activate" | "deactivate" | "drain", activationId: string) {
      controllerRevision += 1;
      controllerPhase =
        operation === "activate" ? "active" : operation === "drain" ? "drained" : "inactive";
      controllerActivationId = operation === "deactivate" ? null : activationId;
      const result =
        operation === "activate"
          ? { kind: "activated", activationId, revision: controllerRevision }
          : operation === "deactivate"
            ? { kind: "deactivated", activationId, revision: controllerRevision }
            : {
                kind: "drained",
                activationId,
                revision: controllerRevision,
                events: [],
                producedThrough: 0,
                truncatedBefore: 0,
                degraded: false,
                replayed: false
              };
      return {
        kind: "sw.main-world-control-result",
        activationId,
        operation,
        controller: state.controllerHint(),
        result
      };
    }
  };
});

vi.mock("../shared/chrome-api.js", () => ({
  getChromeApi: () => ({
    runtime: {
      connect: vi.fn(() => state.port),
      getURL: () => "./content-agent.js",
      onMessage: {
        addListener: (listener: (typeof state.runtimeListeners)[number]) => {
          state.runtimeListeners.push(listener);
        },
        removeListener: (listener: (typeof state.runtimeListeners)[number]) => {
          const index = state.runtimeListeners.indexOf(listener);
          if (index >= 0) state.runtimeListeners.splice(index, 1);
        }
      },
      sendMessage: vi.fn(async (message: Record<string, unknown>) => {
        state.sentMessages.push(message);

        if (message.kind === "content.ready") {
          return {
            kind: "sw.content-prepare",
            readyId: message.readyId,
            activationId: state.nextActivationId(),
            sid: "S-content",
            tabId: 7,
            mode: "lite",
            sampling: {
              mousemoveHz: 20,
              scrollHz: 15,
              domFlushMs: 100,
              snapshotIntervalMs: 20_000,
              screenshotIdleMs: 0,
              bodyCaptureMaxBytes: 64_000
            },
            capturePolicy: DEFAULT_CAPTURE_POLICY,
            mainWorldController: state.controllerHint()
          };
        }

        if (message.kind === "content.main-world-control") {
          return state.controlMainWorld(
            message.operation as "activate" | "deactivate" | "drain",
            message.activationId as string
          );
        }

        return { ok: true };
      })
    }
  })
}));

vi.mock("./content-agent.js", () => ({
  createContentCaptureAgent: (options: Parameters<typeof state.setAgentOptions>[0]) => {
    return state.createAgent(options);
  }
}));

async function dispatchRuntimeMessage(message: unknown): Promise<unknown> {
  const listener = state.runtimeListeners[0];
  let response: unknown;
  listener?.(message, {}, (value) => {
    response = value;
  });
  await vi.waitFor(() => expect(state.runtimeListeners.length).toBeGreaterThan(0));
  await Promise.resolve();
  return response;
}

function persistedPageEvent(type: "pagehide" | "pageshow"): Event {
  const event = new Event(type);
  Object.defineProperty(event, "persisted", { value: true });
  return event;
}

describe("content activation runtime", () => {
  beforeAll(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.replaceState({}, "", "/dashboard");
    await import("./index.js");
    await vi.waitFor(() =>
      expect(
        state.sentMessages.some(
          (message) => (message as { kind?: unknown }).kind === "content.ready"
        )
      ).toBe(true)
    );
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("preloads inertly, binds explicitly, drains in order, and rotates BFCache identity", async () => {
    const ready = state.sentMessages.find(
      (message) => (message as { kind?: unknown }).kind === "content.ready"
    ) as Record<string, unknown>;
    expect(ready.reason).toBe("recovery");
    expect(ready.currentActivationId).toBeUndefined();

    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(state.agentOptions).not.toBeNull());
    expect(state.agentCreationCalls).toBe(2);
    let activationId = state.currentActivationId();
    expect(state.agentStates).toHaveLength(0);
    expect(state.portMessages).toHaveLength(0);
    await vi.waitFor(() =>
      expect(
        state.sentMessages.some(
          (message) =>
            (message as { kind?: unknown; activationId?: unknown }).kind === "content.armed" &&
            (message as { activationId?: unknown }).activationId === activationId
        )
      ).toBe(true)
    );

    await dispatchRuntimeMessage({ kind: "sw.content-activated", activationId });
    await vi.waitFor(() => expect(state.agentOptions).not.toBeNull());
    await vi.waitFor(() =>
      expect(
        state.portMessages.some(
          (message) => (message as { kind?: unknown }).kind === "content.bind"
        )
      ).toBe(true)
    );
    expect(
      state.portMessages.some(
        (message) => (message as { kind?: unknown }).kind === "content.events"
      )
    ).toBe(false);

    state.agentOptions!.emitBatch(
      [
        {
          source: "content",
          rawType: "click",
          sid: "S-content",
          tabId: 7,
          t: 2,
          mono: 2,
          payload: {}
        }
      ],
      activationId
    );
    for (const listener of [...state.portMessageListeners]) {
      listener({ kind: "sw.content-bound", activationId });
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(
      state.portMessages.filter(
        (message) => (message as { kind?: unknown }).kind === "content.events"
      )
    ).toHaveLength(1);
    const firstBatch = state.portMessages.find(
      (message) => (message as { kind?: unknown }).kind === "content.events"
    ) as { batchId: string };
    state.setFlushEvent({
      source: "content",
      rawType: "keydown",
      sid: "S-content",
      tabId: 7,
      t: 2.25,
      mono: 2.25,
      payload: { key: "Enter" }
    });
    const readyCountBeforeBindRecovery = state.sentMessages.filter(
      (message) => (message as { kind?: unknown }).kind === "content.ready"
    ).length;
    await vi.advanceTimersByTimeAsync(2_250);
    await vi.advanceTimersByTimeAsync(2_250);
    await vi.advanceTimersByTimeAsync(2_250);
    await vi.advanceTimersByTimeAsync(2_250);
    await vi.waitFor(() =>
      expect(
        state.sentMessages.filter(
          (message) => (message as { kind?: unknown }).kind === "content.ready"
        ).length
      ).toBeGreaterThan(readyCountBeforeBindRecovery)
    );
    const recoveredActivationId = state.currentActivationId();
    expect(recoveredActivationId).not.toBe(activationId);
    await vi.waitFor(() =>
      expect(
        state.sentMessages.some(
          (message) =>
            (message as { kind?: unknown; activationId?: unknown }).kind === "content.armed" &&
            (message as { activationId?: unknown }).activationId === recoveredActivationId
        )
      ).toBe(true)
    );
    await dispatchRuntimeMessage({
      kind: "sw.content-activated",
      activationId: recoveredActivationId
    });
    await vi.waitFor(() =>
      expect(
        state.portMessages.some(
          (message) =>
            (message as { kind?: unknown; activationId?: unknown }).kind === "content.bind" &&
            (message as { activationId?: unknown }).activationId === recoveredActivationId
        )
      ).toBe(true)
    );
    for (const listener of [...state.portMessageListeners]) {
      listener({ kind: "sw.content-bound", activationId: recoveredActivationId });
    }
    await vi.waitFor(() =>
      expect(
        state.portMessages.filter(
          (message) =>
            (message as { kind?: unknown; batchId?: unknown }).kind === "content.events" &&
            (message as { batchId?: unknown }).batchId === firstBatch.batchId
        )
      ).toHaveLength(2)
    );
    const replayedBatch = state.portMessages.filter(
      (message) =>
        (message as { kind?: unknown; batchId?: unknown }).kind === "content.events" &&
        (message as { batchId?: unknown }).batchId === firstBatch.batchId
    )[1] as { activationId?: string; events?: unknown[] };
    expect(replayedBatch.activationId).toBe(recoveredActivationId);
    expect(replayedBatch.events).toHaveLength(1);
    activationId = recoveredActivationId;
    for (const listener of [...state.portMessageListeners]) {
      listener({
        kind: "sw.content-events-ack",
        activationId,
        batchId: firstBatch.batchId
      });
    }
    await vi.waitFor(() =>
      expect(
        [...state.portMessages]
          .reverse()
          .find(
            (message) =>
              (message as { kind?: unknown; batchId?: unknown }).kind === "content.events" &&
              (message as { batchId?: unknown }).batchId !== firstBatch.batchId
          )
      ).toBeDefined()
    );
    const recoveredSuffix = [...state.portMessages]
      .reverse()
      .find(
        (message) =>
          (message as { kind?: unknown; batchId?: unknown }).kind === "content.events" &&
          (message as { batchId?: unknown }).batchId !== firstBatch.batchId
      ) as { batchId: string; events: Array<{ rawType?: string }> };
    expect(recoveredSuffix.events.map((event) => event.rawType)).toContain("keydown");
    for (const listener of [...state.portMessageListeners]) {
      listener({
        kind: "sw.content-events-ack",
        activationId,
        batchId: recoveredSuffix.batchId
      });
    }

    const predecessorActivationId = activationId;
    const predecessorDocumentUrl = window.location.href;
    const eventBatchCountBeforeRapidTransitions = state.portMessages.filter(
      (message) => (message as { kind?: unknown }).kind === "content.events"
    ).length;
    state.agentOptions!.emitBatch(
      [
        {
          source: "content",
          rawType: "rapid-transition",
          sid: "S-content",
          tabId: 7,
          t: 2.4,
          mono: 2.4,
          payload: {}
        }
      ],
      predecessorActivationId
    );
    await vi.advanceTimersByTimeAsync(550);
    await vi.waitFor(() =>
      expect(
        state.portMessages.filter(
          (message) => (message as { kind?: unknown }).kind === "content.events"
        )
      ).toHaveLength(eventBatchCountBeforeRapidTransitions + 1)
    );
    const predecessorBatch = [...state.portMessages]
      .reverse()
      .find((message) => (message as { kind?: unknown }).kind === "content.events") as {
      activationId: string;
      batchId: string;
      events: Array<{ rawType?: string }>;
    };
    expect(predecessorBatch.activationId).toBe(predecessorActivationId);
    expect(predecessorBatch.events.map((event) => event.rawType)).toEqual(["rapid-transition"]);

    const readyCountBeforePolicyRevocation = state.sentMessages.filter(
      (message) => (message as { kind?: unknown }).kind === "content.ready"
    ).length;
    await dispatchRuntimeMessage({
      kind: "sw.content-revoked",
      activationId: predecessorActivationId,
      reason: "same-document-policy-pending"
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(
      state.sentMessages.filter(
        (message) => (message as { kind?: unknown }).kind === "content.ready"
      )
    ).toHaveLength(readyCountBeforePolicyRevocation);

    const documentId = "rapid-transition-document";
    window.history.replaceState({}, "", "/dashboard?step=b");
    const provisionalDocumentUrl = window.location.href;
    await dispatchRuntimeMessage({
      kind: "sw.request-content-ready",
      sameDocumentTransition: {
        previousActivationId: predecessorActivationId,
        frameId: 0,
        documentId,
        previousDocumentUrl: predecessorDocumentUrl,
        documentUrl: provisionalDocumentUrl,
        revision: 10
      }
    });
    const provisionalActivationId = state.currentActivationId();
    await vi.waitFor(() =>
      expect(
        state.sentMessages.some(
          (message) =>
            (message as { kind?: unknown; activationId?: unknown }).kind === "content.armed" &&
            (message as { activationId?: unknown }).activationId === provisionalActivationId
        )
      ).toBe(true)
    );

    window.history.replaceState({}, "", "/dashboard?step=c");
    const finalDocumentUrl = window.location.href;
    await dispatchRuntimeMessage({
      kind: "sw.request-content-ready",
      sameDocumentTransition: {
        previousActivationId: predecessorActivationId,
        frameId: 0,
        documentId,
        previousDocumentUrl: predecessorDocumentUrl,
        documentUrl: finalDocumentUrl,
        revision: 11
      }
    });
    const finalActivationId = state.currentActivationId();
    expect(finalActivationId).not.toBe(provisionalActivationId);
    await vi.waitFor(() =>
      expect(
        state.sentMessages.some(
          (message) =>
            (message as { kind?: unknown; activationId?: unknown }).kind === "content.armed" &&
            (message as { activationId?: unknown }).activationId === finalActivationId
        )
      ).toBe(true)
    );
    await dispatchRuntimeMessage({
      kind: "sw.content-activated",
      activationId: finalActivationId
    });
    await vi.waitFor(() =>
      expect(
        state.portMessages.some(
          (message) =>
            (message as { kind?: unknown; activationId?: unknown }).kind === "content.bind" &&
            (message as { activationId?: unknown }).activationId === finalActivationId
        )
      ).toBe(true)
    );
    for (const listener of [...state.portMessageListeners]) {
      listener({ kind: "sw.content-bound", activationId: finalActivationId });
    }
    await vi.waitFor(() =>
      expect(
        state.portMessages.filter(
          (message) =>
            (message as { kind?: unknown; batchId?: unknown }).kind === "content.events" &&
            (message as { batchId?: unknown }).batchId === predecessorBatch.batchId
        )
      ).toHaveLength(2)
    );
    const reboundPredecessorBatch = [...state.portMessages]
      .reverse()
      .find(
        (message) =>
          (message as { kind?: unknown; batchId?: unknown }).kind === "content.events" &&
          (message as { batchId?: unknown }).batchId === predecessorBatch.batchId
      ) as { activationId?: string; documentUrl?: string };
    expect(reboundPredecessorBatch).toMatchObject({
      activationId: finalActivationId,
      documentUrl: finalDocumentUrl
    });
    for (const listener of [...state.portMessageListeners]) {
      listener({
        kind: "sw.content-events-ack",
        activationId: finalActivationId,
        batchId: predecessorBatch.batchId
      });
    }
    activationId = finalActivationId;

    const flushCallsBeforeQuiesce = state.flushCalls;
    const batchesBeforeQuiesce = state.portMessages.filter(
      (message) => (message as { kind?: unknown }).kind === "content.events"
    ).length;
    state.agentOptions!.emitBatch(
      [
        {
          source: "content",
          rawType: "keydown",
          sid: "S-content",
          tabId: 7,
          t: 2.5,
          mono: 2.5,
          payload: {}
        }
      ],
      activationId
    );
    await dispatchRuntimeMessage({ kind: "sw.content-quiesce", activationId });
    await vi.waitFor(() => expect(state.quiesceCalls).toBe(1));
    await vi.advanceTimersByTimeAsync(550);
    await vi.waitFor(() => expect(state.freezeCalls).toBe(1));
    expect(state.flushCalls).toBe(flushCallsBeforeQuiesce + 2);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(
      state.portMessages.filter(
        (message) => (message as { kind?: unknown }).kind === "content.events"
      )
    ).toHaveLength(batchesBeforeQuiesce);

    state.setFlushEvent({
      source: "content",
      rawType: "submit",
      sid: "S-content",
      tabId: 7,
      t: 3,
      mono: 3,
      payload: {}
    });
    await dispatchRuntimeMessage({
      kind: "sw.content-drain",
      activationId,
      sid: "S-content",
      token: "a".repeat(64),
      deadline: Date.now() + 10_000,
      documentUrl: window.location.href
    });
    await vi.waitFor(() => expect(state.prepareStopCalls).toBe(1));
    expect(state.freezeCalls).toBe(2);
    expect(state.flushCalls).toBe(flushCallsBeforeQuiesce + 3);
    expect(
      state.portMessages.some(
        (message) =>
          (message as { kind?: unknown; stopDrainToken?: unknown }).kind === "content.events" &&
          (message as { stopDrainToken?: unknown }).stopDrainToken === "a".repeat(64)
      )
    ).toBe(true);
    expect(
      state.portMessages.some(
        (message) => (message as { kind?: unknown }).kind === "content.stop-drained"
      )
    ).toBe(false);

    const drainBatch = [...state.portMessages]
      .reverse()
      .find(
        (message) =>
          (message as { kind?: unknown; stopDrainToken?: unknown }).kind === "content.events" &&
          (message as { stopDrainToken?: unknown }).stopDrainToken === "a".repeat(64)
      ) as { batchId: string };
    for (const listener of [...state.portMessageListeners]) {
      listener({
        kind: "sw.content-events-ack",
        activationId,
        batchId: drainBatch.batchId
      });
    }

    state.finishPrepareStop();
    await vi.waitFor(() =>
      expect(
        state.portMessages.some(
          (message) => (message as { kind?: unknown }).kind === "content.stop-drained"
        )
      ).toBe(true)
    );
    const firstDrainAckCount = state.portMessages.filter(
      (message) => (message as { kind?: unknown }).kind === "content.stop-drained"
    ).length;
    await vi.advanceTimersByTimeAsync(550);
    expect(
      state.portMessages.filter(
        (message) => (message as { kind?: unknown }).kind === "content.stop-drained"
      ).length
    ).toBeGreaterThan(firstDrainAckCount);

    const readyCountBeforeBfCache = state.sentMessages.filter(
      (message) => (message as { kind?: unknown }).kind === "content.ready"
    ).length;
    window.dispatchEvent(persistedPageEvent("pagehide"));
    window.dispatchEvent(persistedPageEvent("pageshow"));
    await vi.waitFor(() =>
      expect(
        state.sentMessages.filter(
          (message) => (message as { kind?: unknown }).kind === "content.ready"
        )
      ).toHaveLength(readyCountBeforeBfCache + 1)
    );
    const resumedReady = state.sentMessages
      .filter((message) => (message as { kind?: unknown }).kind === "content.ready")
      .at(-1) as Record<string, unknown>;

    expect(resumedReady.reason).toBe("pageshow");
    expect(resumedReady.readyId).not.toBe(ready.readyId);
    expect(resumedReady.currentActivationId).toBe(activationId);
    expect(resumedReady.mainWorldController).toMatchObject({
      secret: "f".repeat(64),
      moduleNonce: `m1_${"e".repeat(64)}`
    });

    const recoveredSeed = (await dispatchRuntimeMessage({
      kind: "sw.main-world-controller-seed",
      controller: {
        secret: "1".repeat(64),
        moduleNonce: `m1_${"2".repeat(64)}`,
        revision: 0,
        phase: "inactive",
        activationId: null
      }
    })) as { kind?: string; controller?: { secret?: string; moduleNonce?: string } };
    expect(recoveredSeed).toMatchObject({
      kind: "content.main-world-controller-seeded",
      controller: {
        secret: "f".repeat(64),
        moduleNonce: `m1_${"e".repeat(64)}`
      }
    });
  });
});
