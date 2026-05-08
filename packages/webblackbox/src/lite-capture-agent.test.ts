/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const snapdomToBlobMock = vi.hoisted(() => vi.fn());

vi.mock("@zumer/snapdom", () => {
  return {
    snapdom: {
      toBlob: snapdomToBlobMock
    }
  };
});

import { INJECTED_MESSAGE_SOURCE } from "./injected-hooks.js";
import { LiteCaptureAgent } from "./lite-capture-agent.js";
import type { LiteCaptureAgentOptions, LiteCaptureState } from "./types.js";

function createAgent(
  state: Partial<LiteCaptureState> = {},
  options: Partial<LiteCaptureAgentOptions> = {}
) {
  const emitBatch = vi.fn();
  const agent = new LiteCaptureAgent({
    emitBatch,
    showIndicator: false,
    ...options
  });

  agent.setRecordingStatus({
    active: true,
    sid: "S-lite-agent-test",
    tabId: 7,
    mode: "lite",
    ...state
  });
  agent.flush();
  emitBatch.mockClear();
  snapdomToBlobMock.mockClear();

  return {
    agent,
    emitBatch
  };
}

function createInactiveAgent(options: Partial<LiteCaptureAgentOptions> = {}) {
  const emitBatch = vi.fn();
  const agent = new LiteCaptureAgent({
    emitBatch,
    showIndicator: false,
    ...options
  });

  return {
    agent,
    emitBatch
  };
}

function dispatchInjectedEvents(rawType: string, count: number): void {
  const startedAt = Date.now();
  const events = Array.from({ length: count }, (_, index) => {
    const now = startedAt + index;

    return {
      rawType,
      payload: {
        index
      },
      t: now,
      mono: performance.timeOrigin + now
    };
  });

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        source: INJECTED_MESSAGE_SOURCE,
        kind: "capture-events",
        events
      },
      source: window
    })
  );
}

function clickTarget(): void {
  const target = document.querySelector<HTMLButtonElement>("#target");

  if (!target) {
    throw new Error("missing click target");
  }

  target.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 48,
      clientY: 32
    })
  );
}

function clickLinkTarget(): void {
  const target = document.querySelector<HTMLElement>("#nav-label");

  if (!target) {
    throw new Error("missing link target");
  }

  target.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 72,
      clientY: 28
    })
  );
}

function inputTarget(): HTMLInputElement {
  const target = document.querySelector<HTMLInputElement>("#field");

  if (!target) {
    throw new Error("missing input target");
  }

  return target;
}

function movePointer(x = 12, y = 18): void {
  document.dispatchEvent(
    new MouseEvent("pointermove", {
      bubbles: true,
      clientX: x,
      clientY: y
    })
  );
}

function dispatchScroll(scrollX: number, scrollY: number): void {
  Object.defineProperty(window, "scrollX", {
    configurable: true,
    value: scrollX
  });
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    value: scrollY
  });
  document.dispatchEvent(new Event("scroll", { bubbles: true }));
}

function dispatchWheel(deltaY = 120): void {
  document.dispatchEvent(
    new WheelEvent("wheel", {
      bubbles: true,
      deltaY
    })
  );
}

function countEmittedEvents(emitBatch: ReturnType<typeof vi.fn>): number {
  return emitBatch.mock.calls.reduce((total, call) => {
    const [events] = call as [Array<unknown>];
    return total + (Array.isArray(events) ? events.length : 0);
  }, 0);
}

function emittedRawTypes(emitBatch: ReturnType<typeof vi.fn>): string[] {
  return emitBatch.mock.calls.flatMap((call) => {
    const [events] = call as [Array<{ rawType?: string }>];
    return events.map((event) => event.rawType ?? "");
  });
}

describe("LiteCaptureAgent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <form id="capture-form">
        <label for="field">Name</label>
        <input id="field" type="text" />
        <button id="target" type="button">Open</button>
        <a id="nav-link" href="#action-target"><span id="nav-label">Jump</span></a>
      </form>
      <section id="action-target">Target</section>
    `;
    snapdomToBlobMock.mockImplementation(() => new Promise(() => undefined));
    Object.defineProperty(window, "scrollX", {
      configurable: true,
      value: 0
    });
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 0
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("does not capture click-driven action screenshots by default", async () => {
    const { agent, emitBatch } = createAgent();

    clickTarget();
    document
      .querySelector<HTMLButtonElement>("#target")
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    document.querySelector<HTMLFormElement>("#capture-form")?.dispatchEvent(
      new Event("submit", {
        bubbles: true,
        cancelable: true
      })
    );

    expect(snapdomToBlobMock).not.toHaveBeenCalled();
    expect(emitBatch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(snapdomToBlobMock).not.toHaveBeenCalled();

    agent.dispose();
  });

  it("captures a deferred start screenshot when screenshot sampling is enabled", async () => {
    const { agent } = createAgent({
      sampling: {
        screenshotIdleMs: 1_000
      }
    });

    await vi.advanceTimersByTimeAsync(3_500);

    expect(snapdomToBlobMock).toHaveBeenCalledTimes(1);

    agent.dispose();
  });

  it("releases screenshot capture state when snapdom does not settle", async () => {
    const { agent } = createAgent({
      sampling: {
        screenshotIdleMs: 1_000
      }
    });
    const state = agent as unknown as {
      screenshotCaptureBlocked: boolean;
      screenshotInFlight: boolean;
    };

    await vi.advanceTimersByTimeAsync(3_500);

    expect(state.screenshotInFlight).toBe(true);
    expect(state.screenshotCaptureBlocked).toBe(true);

    await vi.advanceTimersByTimeAsync(4_000);

    expect(state.screenshotInFlight).toBe(false);
    expect(state.screenshotCaptureBlocked).toBe(true);

    await agent.prepareStopCapture();

    expect(snapdomToBlobMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(8_000);

    expect(snapdomToBlobMock).toHaveBeenCalledTimes(1);

    agent.dispose();
  });

  it("captures a stop screenshot when the session stops before the first idle screenshot lands", async () => {
    const { agent } = createAgent({
      sampling: {
        screenshotIdleMs: 1_000
      }
    });
    const captureScreenshotSpy = vi
      .spyOn(
        agent as unknown as {
          captureScreenshot: (reason: string) => Promise<void>;
        },
        "captureScreenshot"
      )
      .mockResolvedValue();

    await agent.prepareStopCapture();

    expect(captureScreenshotSpy).toHaveBeenCalledWith("stop");

    agent.dispose();
  });

  it("installs capture listeners only while recording is active", () => {
    const { agent, emitBatch } = createInactiveAgent();

    clickTarget();
    agent.flush();
    expect(emitBatch).not.toHaveBeenCalled();

    agent.setRecordingStatus({
      active: true,
      sid: "S-lite-agent-test",
      tabId: 7,
      mode: "lite"
    });
    emitBatch.mockClear();

    clickTarget();
    agent.flush();
    expect(emittedRawTypes(emitBatch)).toContain("click");

    emitBatch.mockClear();
    agent.setRecordingStatus({
      active: false,
      sid: "S-lite-agent-test",
      tabId: 7,
      mode: "lite"
    });
    emitBatch.mockClear();

    clickTarget();
    agent.flush();
    expect(emitBatch).not.toHaveBeenCalled();

    agent.dispose();
  });

  it("does not install page performance observers in full mode", () => {
    const observe = vi.fn();
    const requestAnimationFrame = vi.fn(() => 1);
    const PerformanceObserverMock = vi.fn(() => ({
      observe,
      disconnect: vi.fn()
    }));

    vi.stubGlobal("PerformanceObserver", PerformanceObserverMock);
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);

    const { agent } = createAgent({ mode: "full" });

    expect(PerformanceObserverMock).not.toHaveBeenCalled();
    expect(requestAnimationFrame).not.toHaveBeenCalled();

    agent.dispose();
  });

  it("throttles full-mode pointer tracking", () => {
    const { agent } = createAgent({ mode: "full" });
    const state = agent as unknown as {
      lastPointerState: { x: number; y: number } | null;
    };

    movePointer(10, 12);
    expect(state.lastPointerState).toMatchObject({ x: 10, y: 12 });

    movePointer(30, 32);
    expect(state.lastPointerState).toMatchObject({ x: 10, y: 12 });

    vi.advanceTimersByTime(251);
    movePointer(40, 42);
    expect(state.lastPointerState).toMatchObject({ x: 40, y: 42 });

    agent.dispose();
  });

  it("defers start capture until the page is idle", async () => {
    const { agent } = createAgent({
      sampling: {
        screenshotIdleMs: 1_000
      }
    });

    await vi.advanceTimersByTimeAsync(1_900);

    movePointer();

    await vi.advanceTimersByTimeAsync(100);
    expect(snapdomToBlobMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_500);
    expect(snapdomToBlobMock).toHaveBeenCalledTimes(1);

    agent.dispose();
  });

  it("disables runtime screenshots when screenshot sampling is set to zero", async () => {
    const { agent } = createAgent({
      sampling: {
        screenshotIdleMs: 0
      }
    });

    expect(
      (agent as unknown as { sampling: { screenshotIdleMs: number } }).sampling.screenshotIdleMs
    ).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(snapdomToBlobMock).not.toHaveBeenCalled();

    agent.dispose();
  });

  it("emits a final dom snapshot when stopping before the idle start capture runs", () => {
    const { agent, emitBatch } = createAgent();

    agent.setRecordingStatus({
      active: false,
      sid: "S-lite-agent-test",
      tabId: 7,
      mode: "lite"
    });

    const emittedRawTypes = emitBatch.mock.calls.flatMap((call) => {
      const [events] = call as [Array<{ rawType?: string }>];
      return events.map((event) => event.rawType);
    });

    expect(emittedRawTypes).toContain("snapshot");

    agent.dispose();
  });

  it("uses summary-only html for routine lite dom snapshots", () => {
    document.body.innerHTML = `
      <main>
        <article id="story">
          <h1>Headline</h1>
          <p>Full DOM content should not be serialized in lite runtime snapshots.</p>
        </article>
      </main>
    `;

    const { agent, emitBatch } = createAgent();

    agent.setRecordingStatus({
      active: false,
      sid: "S-lite-agent-test",
      tabId: 7,
      mode: "lite"
    });

    const snapshotEvent = emitBatch.mock.calls
      .flatMap((call) => {
        const [batch] = call as [Array<{ rawType?: string; payload?: Record<string, unknown> }>];
        return batch;
      })
      .find((entry) => entry.rawType === "snapshot");

    expect(snapshotEvent?.payload).toMatchObject({
      summaryOnly: true,
      summaryMode: "runtime-lite",
      truncated: true
    });
    expect(typeof snapshotEvent?.payload?.html).toBe("string");
    expect(String(snapshotEvent?.payload?.html)).toContain('data-webblackbox-summary="true"');
    expect(String(snapshotEvent?.payload?.html)).not.toContain("Full DOM content should not");

    agent.dispose();
  });

  it("keeps child-frame capture lightweight", async () => {
    const { agent, emitBatch } = createAgent(
      {
        sampling: {
          screenshotIdleMs: 1_000
        }
      },
      {
        frameScope: "child"
      }
    );

    clickTarget();
    await vi.advanceTimersByTimeAsync(3_000);

    agent.setRecordingStatus({
      active: false,
      sid: "S-lite-agent-test",
      tabId: 7,
      mode: "lite",
      sampling: {
        screenshotIdleMs: 1_000
      }
    });

    const rawTypes = emittedRawTypes(emitBatch);

    expect(rawTypes).toContain("click");
    expect(rawTypes).not.toContain("snapshot");
    expect(rawTypes).not.toContain("localStorageSnapshot");
    expect(rawTypes).not.toContain("cookieSnapshot");
    expect(rawTypes).not.toContain("indexedDbSnapshot");
    expect(snapdomToBlobMock).not.toHaveBeenCalled();

    agent.dispose();
  });

  it("emits a counts-only localStorage snapshot when stopping before idle storage capture runs", () => {
    localStorage.setItem("demo", "local-storage-secret-token");
    const { agent, emitBatch } = createAgent();

    agent.setRecordingStatus({
      active: false,
      sid: "S-lite-agent-test",
      tabId: 7,
      mode: "lite"
    });

    const events = emitBatch.mock.calls.flatMap((call) => {
      const [batch] = call as [Array<{ rawType?: string; payload?: Record<string, unknown> }>];
      return batch;
    });
    const storageEvent = events.find((event) => event.rawType === "localStorageSnapshot");

    expect(storageEvent?.payload).toMatchObject({
      count: 1,
      mode: "counts-only",
      redacted: true
    });
    expect(storageEvent?.payload).not.toHaveProperty("entries");
    expect(JSON.stringify(storageEvent)).not.toContain("local-storage-secret-token");

    agent.dispose();
  });

  it("emits counts-only cookie snapshots", () => {
    vi.spyOn(document, "cookie", "get").mockReturnValue("sessionSecret=cookie-secret-token");
    const { agent, emitBatch } = createAgent();

    agent.emitMarker("capture storage metadata");
    agent.flush();

    const events = emitBatch.mock.calls.flatMap((call) => {
      const [batch] = call as [Array<{ rawType?: string; payload?: Record<string, unknown> }>];
      return batch;
    });
    const cookieEvent = events.find((event) => event.rawType === "cookieSnapshot");

    expect(cookieEvent?.payload).toMatchObject({
      mode: "counts-only",
      redacted: true
    });
    expect(cookieEvent?.payload).not.toHaveProperty("names");
    expect(JSON.stringify(cookieEvent)).not.toContain("sessionSecret");
    expect(JSON.stringify(cookieEvent)).not.toContain("cookie-secret-token");

    agent.dispose();
  });

  it("holds oversized mutation bursts until pressure cools, then emits a sampled summary", async () => {
    let observeCallback: MutationCallback | null = null;
    const disconnect = vi.fn();
    const OriginalMutationObserver = globalThis.MutationObserver;

    class MockMutationObserver {
      public constructor(callback: MutationCallback) {
        observeCallback = callback;
      }

      public disconnect = disconnect;

      public observe = vi.fn();

      public takeRecords(): MutationRecord[] {
        return [];
      }
    }

    globalThis.MutationObserver = MockMutationObserver as unknown as typeof MutationObserver;

    try {
      const { agent, emitBatch } = createAgent();
      const target = document.querySelector("#target");

      if (!(target instanceof Element) || observeCallback === null) {
        throw new Error("missing mutation observer callback");
      }

      const callback: MutationCallback = observeCallback;

      const record = {
        type: "childList",
        target,
        addedNodes: { length: 1 } as NodeList,
        removedNodes: { length: 0 } as NodeList
      } as unknown as MutationRecord;

      callback(
        Array.from({ length: 260 }, () => record),
        {} as MutationObserver
      );
      await vi.advanceTimersByTimeAsync(350);
      agent.flush();

      expect(emittedRawTypes(emitBatch)).not.toContain("mutation");

      await vi.advanceTimersByTimeAsync(2_600);
      agent.flush();

      const mutationEvent = emitBatch.mock.calls
        .flatMap((call) => {
          const [batch] = call as [Array<{ rawType?: string; payload?: Record<string, unknown> }>];
          return batch;
        })
        .find((entry) => entry.rawType === "mutation");

      expect(mutationEvent?.payload?.summary).toMatchObject({
        count: 260,
        sampledCount: 80,
        truncated: true
      });

      agent.dispose();
    } finally {
      globalThis.MutationObserver = OriginalMutationObserver;
    }
  });

  it("uses a lightweight summary html snapshot for large pages", () => {
    document.body.innerHTML = `
      <section id="grid">
        ${Array.from({ length: 4_200 }, (_, index) => `<div class="cell">cell-${index}</div>`).join("")}
      </section>
    `;

    const { agent, emitBatch } = createAgent();

    agent.setRecordingStatus({
      active: false,
      sid: "S-lite-agent-test",
      tabId: 7,
      mode: "lite"
    });

    const snapshotEvent = emitBatch.mock.calls
      .flatMap((call) => {
        const [batch] = call as [Array<{ rawType?: string; payload?: Record<string, unknown> }>];
        return batch;
      })
      .find((entry) => entry.rawType === "snapshot");

    expect(snapshotEvent?.payload).toMatchObject({
      summaryOnly: true,
      summaryMode: "large-dom",
      truncated: true
    });
    expect(typeof snapshotEvent?.payload?.html).toBe("string");
    expect(String(snapshotEvent?.payload?.html)).toContain('data-webblackbox-summary="true"');
    expect(String(snapshotEvent?.payload?.html)).toContain("WebBlackbox Lite DOM Summary");
    expect(String(snapshotEvent?.payload?.html)).not.toContain("cell-4199");

    agent.dispose();
  });

  it("defers start capture while mutation pressure is active", async () => {
    let observeCallback: MutationCallback | null = null;
    const OriginalMutationObserver = globalThis.MutationObserver;

    class MockMutationObserver {
      public constructor(callback: MutationCallback) {
        observeCallback = callback;
      }

      public disconnect = vi.fn();

      public observe = vi.fn();

      public takeRecords(): MutationRecord[] {
        return [];
      }
    }

    globalThis.MutationObserver = MockMutationObserver as unknown as typeof MutationObserver;

    try {
      const { agent, emitBatch } = createAgent();
      const target = document.querySelector("#target");

      if (!(target instanceof Element) || observeCallback === null) {
        throw new Error("missing mutation observer callback");
      }

      const callback: MutationCallback = observeCallback;

      const record = {
        type: "childList",
        target,
        addedNodes: { length: 1 } as NodeList,
        removedNodes: { length: 0 } as NodeList
      } as unknown as MutationRecord;

      callback(
        Array.from({ length: 260 }, () => record),
        {} as MutationObserver
      );
      await vi.advanceTimersByTimeAsync(2_100);
      agent.flush();

      expect(emittedRawTypes(emitBatch)).not.toContain("snapshot");

      emitBatch.mockClear();

      await vi.advanceTimersByTimeAsync(1_600);
      agent.flush();

      expect(emittedRawTypes(emitBatch)).toContain("snapshot");

      agent.dispose();
    } finally {
      globalThis.MutationObserver = OriginalMutationObserver;
    }
  });

  it("defers start capture while editable input pressure is active", async () => {
    const { agent, emitBatch } = createAgent();
    const field = inputTarget();

    await vi.advanceTimersByTimeAsync(1_900);

    for (let index = 0; index < 6; index += 1) {
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "A",
          code: "KeyA",
          bubbles: true
        })
      );
    }

    await vi.advanceTimersByTimeAsync(200);
    agent.flush();

    expect(emittedRawTypes(emitBatch)).not.toContain("snapshot");

    emitBatch.mockClear();

    await vi.advanceTimersByTimeAsync(3_100);
    agent.flush();

    expect(emittedRawTypes(emitBatch)).toContain("snapshot");

    agent.dispose();
  });

  it("defers start capture while governor long-task pressure is active", async () => {
    const { agent, emitBatch } = createAgent();
    const state = agent as unknown as { longTaskPressureUntilMono: number };

    state.longTaskPressureUntilMono = performance.timeOrigin + performance.now() + 10_000;

    await vi.advanceTimersByTimeAsync(2_100);
    agent.flush();

    expect(emittedRawTypes(emitBatch)).not.toContain("snapshot");

    emitBatch.mockClear();
    state.longTaskPressureUntilMono = Number.NEGATIVE_INFINITY;

    await vi.advanceTimersByTimeAsync(1_700);
    agent.flush();

    expect(emittedRawTypes(emitBatch)).toContain("snapshot");

    agent.dispose();
  });

  it("reduces mutation sampling further while editable input pressure is active", async () => {
    let observeCallback: MutationCallback | null = null;
    const OriginalMutationObserver = globalThis.MutationObserver;

    class MockMutationObserver {
      public constructor(callback: MutationCallback) {
        observeCallback = callback;
      }

      public disconnect = vi.fn();

      public observe = vi.fn();

      public takeRecords(): MutationRecord[] {
        return [];
      }
    }

    globalThis.MutationObserver = MockMutationObserver as unknown as typeof MutationObserver;

    try {
      const { agent, emitBatch } = createAgent();
      const field = inputTarget();
      const target = document.querySelector("#target");

      if (!(target instanceof Element) || observeCallback === null) {
        throw new Error("missing mutation observer callback");
      }

      const callback: MutationCallback = observeCallback;

      for (let index = 0; index < 6; index += 1) {
        field.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "A",
            code: "KeyA",
            bubbles: true
          })
        );
      }

      const record = {
        type: "childList",
        target,
        addedNodes: { length: 1 } as NodeList,
        removedNodes: { length: 0 } as NodeList
      } as unknown as MutationRecord;

      callback(
        Array.from({ length: 260 }, () => record),
        {} as MutationObserver
      );
      await vi.advanceTimersByTimeAsync(2_700);
      agent.flush();

      const mutationEvent = emitBatch.mock.calls
        .flatMap((call) => {
          const [batch] = call as [Array<{ rawType?: string; payload?: Record<string, unknown> }>];
          return batch;
        })
        .find((entry) => entry.rawType === "mutation");

      expect(mutationEvent?.payload?.summary).toMatchObject({
        count: 260,
        sampledCount: 16,
        truncated: true
      });

      agent.dispose();
    } finally {
      globalThis.MutationObserver = OriginalMutationObserver;
    }
  });

  it("enters quiet mode for sustained mutation churn and recovers with a summary snapshot", async () => {
    let observeCallback: MutationCallback | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();
    const OriginalMutationObserver = globalThis.MutationObserver;

    class MockMutationObserver {
      public constructor(callback: MutationCallback) {
        observeCallback = callback;
      }

      public disconnect = disconnect;

      public observe = observe;

      public takeRecords(): MutationRecord[] {
        return [];
      }
    }

    globalThis.MutationObserver = MockMutationObserver as unknown as typeof MutationObserver;

    try {
      const { agent, emitBatch } = createAgent();
      const target = document.querySelector("#target");

      if (!(target instanceof Element) || observeCallback === null) {
        throw new Error("missing mutation observer callback");
      }

      const callback: MutationCallback = observeCallback;
      const record = {
        type: "childList",
        target,
        addedNodes: { length: 1 } as NodeList,
        removedNodes: { length: 0 } as NodeList
      } as unknown as MutationRecord;

      callback(
        Array.from({ length: 420 }, () => record),
        {} as MutationObserver
      );
      await vi.advanceTimersByTimeAsync(50);
      agent.flush();

      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(emittedRawTypes(emitBatch)).not.toContain("mutation");

      emitBatch.mockClear();

      await vi.advanceTimersByTimeAsync(3_200);
      agent.flush();

      const snapshotEvent = emitBatch.mock.calls
        .flatMap((call) => {
          const [batch] = call as [Array<{ rawType?: string; payload?: Record<string, unknown> }>];
          return batch;
        })
        .find(
          (entry) => entry.rawType === "snapshot" && entry.payload?.reason === "pressure-recovery"
        );

      expect(snapshotEvent?.payload).toMatchObject({
        summaryOnly: true,
        summaryMode: "pressure",
        reason: "pressure-recovery"
      });
      expect(observe.mock.calls.length).toBeGreaterThanOrEqual(2);

      agent.dispose();
    } finally {
      globalThis.MutationObserver = OriginalMutationObserver;
    }
  });

  it("enters quiet mode during rapid scroll bursts and recovers with a summary snapshot", async () => {
    const OriginalMutationObserver = globalThis.MutationObserver;
    let observeCallback: MutationCallback | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();

    class MockMutationObserver {
      public constructor(callback: MutationCallback) {
        observeCallback = callback;
      }

      public disconnect = disconnect;

      public observe = observe;

      public takeRecords(): MutationRecord[] {
        return [];
      }
    }

    globalThis.MutationObserver = MockMutationObserver as unknown as typeof MutationObserver;

    try {
      const { agent, emitBatch } = createAgent();

      if (observeCallback === null) {
        throw new Error("missing mutation observer callback");
      }

      for (let index = 0; index < 6; index += 1) {
        dispatchWheel();
        dispatchScroll(0, (index + 1) * 160);
      }

      await vi.advanceTimersByTimeAsync(50);
      agent.flush();

      expect(disconnect).toHaveBeenCalledTimes(1);

      emitBatch.mockClear();

      await vi.advanceTimersByTimeAsync(2_300);
      agent.flush();

      const snapshotEvent = emitBatch.mock.calls
        .flatMap((call) => {
          const [batch] = call as [Array<{ rawType?: string; payload?: Record<string, unknown> }>];
          return batch;
        })
        .find(
          (entry) => entry.rawType === "snapshot" && entry.payload?.reason === "pressure-recovery"
        );

      expect(snapshotEvent?.payload).toMatchObject({
        summaryOnly: true,
        summaryMode: "pressure",
        reason: "pressure-recovery"
      });
      expect(observe).toHaveBeenCalledTimes(2);

      agent.dispose();
    } finally {
      globalThis.MutationObserver = OriginalMutationObserver;
    }
  });

  it("enters quiet mode for rich-text editing churn", async () => {
    let observeCallback: MutationCallback | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();
    const OriginalMutationObserver = globalThis.MutationObserver;

    class MockMutationObserver {
      public constructor(callback: MutationCallback) {
        observeCallback = callback;
      }

      public disconnect = disconnect;

      public observe = observe;

      public takeRecords(): MutationRecord[] {
        return [];
      }
    }

    globalThis.MutationObserver = MockMutationObserver as unknown as typeof MutationObserver;

    try {
      document.body.insertAdjacentHTML(
        "beforeend",
        '<div id="editor" contenteditable="true">editable</div>'
      );

      const { agent, emitBatch } = createAgent();
      const editor = document.querySelector<HTMLElement>("#editor");

      if (!editor || observeCallback === null) {
        throw new Error("missing editor target");
      }

      editor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "A",
          code: "KeyA",
          bubbles: true
        })
      );

      const callback: MutationCallback = observeCallback;
      const record = {
        type: "childList",
        target: editor,
        addedNodes: { length: 1 } as NodeList,
        removedNodes: { length: 0 } as NodeList
      } as unknown as MutationRecord;

      callback([record], {} as MutationObserver);
      await vi.advanceTimersByTimeAsync(50);
      agent.flush();

      expect(disconnect).toHaveBeenCalledTimes(1);

      emitBatch.mockClear();

      await vi.advanceTimersByTimeAsync(5_900);
      agent.flush();

      const snapshotEvent = emitBatch.mock.calls
        .flatMap((call) => {
          const [batch] = call as [Array<{ rawType?: string; payload?: Record<string, unknown> }>];
          return batch;
        })
        .find(
          (entry) => entry.rawType === "snapshot" && entry.payload?.reason === "pressure-recovery"
        );

      expect(snapshotEvent?.payload).toMatchObject({
        summaryOnly: true,
        summaryMode: "pressure",
        reason: "pressure-recovery"
      });
      expect(observe).toHaveBeenCalledTimes(2);

      agent.dispose();
    } finally {
      globalThis.MutationObserver = OriginalMutationObserver;
    }
  });

  it("uses lightweight targets for keydown, focus, blur, change, and submit", () => {
    const { agent, emitBatch } = createAgent();
    const field = inputTarget();
    const form = document.querySelector<HTMLFormElement>("#capture-form");

    if (!form) {
      throw new Error("missing form target");
    }

    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "A",
        code: "KeyA",
        bubbles: true
      })
    );
    field.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    field.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    agent.flush();

    const events = emitBatch.mock.calls.flatMap((call) => {
      const [batch] = call as [Array<{ rawType?: string; payload?: Record<string, unknown> }>];
      return batch;
    });

    for (const rawType of ["keydown", "focus", "blur", "input", "submit"]) {
      const event = events.find((entry) => entry.rawType === rawType);
      const target = event?.payload?.target as Record<string, unknown> | undefined;

      expect(event).toBeDefined();
      expect(target).toMatchObject({
        tag: rawType === "submit" ? "FORM" : "INPUT"
      });
      expect(target).not.toHaveProperty("selector");
      expect(target).not.toHaveProperty("text");
    }

    agent.dispose();
  });

  it("enriches input selectors after the hot path", async () => {
    const { agent, emitBatch } = createAgent();
    const field = inputTarget();

    field.value = "Alice";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    agent.flush();

    const inputEvent = emitBatch.mock.calls
      .flatMap((call) => {
        const [batch] = call as [Array<{ rawType?: string; payload?: Record<string, unknown> }>];
        return batch;
      })
      .find((entry) => entry.rawType === "input");

    expect(inputEvent?.payload?.target).toMatchObject({
      tag: "INPUT"
    });
    expect(inputEvent?.payload?.target).toHaveProperty("idToken");
    expect(JSON.stringify(inputEvent?.payload?.target)).not.toContain("field");
    expect(inputEvent?.payload?.target).not.toHaveProperty("selector");

    await vi.advanceTimersByTimeAsync(0);

    expect(inputEvent?.payload?.target).toMatchObject({
      tag: "INPUT",
      idToken: expect.stringMatching(/^t_[a-z0-9]+$/),
      selector: expect.stringMatching(/^input\[id:t_[a-z0-9]+\]$/)
    });
    expect(JSON.stringify(inputEvent?.payload?.target)).not.toContain("field");

    agent.dispose();
  });

  it("records input metadata without raw values", () => {
    const { agent, emitBatch } = createAgent();
    const field = inputTarget();

    field.value = "customer-secret-token";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    agent.flush();

    const inputEvent = emitBatch.mock.calls
      .flatMap((call) => {
        const [batch] = call as [Array<{ rawType?: string; payload?: Record<string, unknown> }>];
        return batch;
      })
      .find((entry) => entry.rawType === "input");

    expect(inputEvent?.payload).toMatchObject({
      inputType: "text",
      length: "customer-secret-token".length,
      valueRedacted: true
    });
    expect(inputEvent?.payload).not.toHaveProperty("value");
    expect(JSON.stringify(inputEvent)).not.toContain("customer-secret-token");

    agent.dispose();
  });

  it("tokenizes target ids, classes, test ids, and text-derived metadata", async () => {
    document.body.innerHTML = `
      <button
        id="customer-email-alice-example-com"
        class="tenant-acme42 danger-action"
        data-testid="delete-secret-customer"
        type="button"
      >Delete Alice Example</button>
    `;
    const { agent, emitBatch } = createAgent();
    const target = document.querySelector("button");

    if (!target) {
      throw new Error("missing tokenized target");
    }

    target.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true
      })
    );
    agent.flush();

    const clickEvent = emitBatch.mock.calls
      .flatMap((call) => {
        const [batch] = call as [Array<{ rawType?: string; payload?: Record<string, unknown> }>];
        return batch;
      })
      .find((entry) => entry.rawType === "click");

    await vi.advanceTimersByTimeAsync(0);

    const targetPayload = clickEvent?.payload?.target as Record<string, unknown> | undefined;
    expect(targetPayload).toMatchObject({
      tag: "BUTTON",
      idToken: expect.stringMatching(/^t_[a-z0-9]+$/),
      dataTestIdToken: expect.stringMatching(/^t_[a-z0-9]+$/),
      selector: expect.stringMatching(/^button\[id:t_[a-z0-9]+\]$/)
    });
    expect(targetPayload?.classTokens).toEqual([
      expect.stringMatching(/^t_[a-z0-9]+$/),
      expect.stringMatching(/^t_[a-z0-9]+$/)
    ]);
    expect(JSON.stringify(targetPayload)).not.toContain("customer-email");
    expect(JSON.stringify(targetPayload)).not.toContain("tenant-acme42");
    expect(JSON.stringify(targetPayload)).not.toContain("delete-secret-customer");
    expect(JSON.stringify(targetPayload)).not.toContain("Delete Alice");
    expect(targetPayload).not.toHaveProperty("id");
    expect(targetPayload).not.toHaveProperty("className");
    expect(targetPayload).not.toHaveProperty("dataTestId");
    expect(targetPayload).not.toHaveProperty("text");

    agent.dispose();
  });

  it("uses lightweight navigation payloads for link clicks so navigation is not blocked", () => {
    const { agent, emitBatch } = createAgent();

    clickLinkTarget();
    agent.flush();

    const clickEvent = emitBatch.mock.calls
      .flatMap((call) => {
        const [batch] = call as [Array<{ rawType?: string; payload?: Record<string, unknown> }>];
        return batch;
      })
      .find((entry) => entry.rawType === "click");

    expect(clickEvent?.payload?.target).toMatchObject({
      selector: expect.stringMatching(/^a\[id:t_[a-z0-9]+\]$/),
      tag: "A",
      idToken: expect.stringMatching(/^t_[a-z0-9]+$/)
    });
    expect(clickEvent?.payload?.target).not.toHaveProperty("href");
    expect(clickEvent?.payload?.target).not.toHaveProperty("hash");
    expect(clickEvent?.payload?.target).not.toHaveProperty("id");
    expect(clickEvent?.payload?.target).not.toHaveProperty("text");
    expect(JSON.stringify(clickEvent?.payload?.target)).not.toContain("nav-link");

    agent.dispose();
  });

  it("enriches non-navigation click selectors after the hot path", async () => {
    const { agent, emitBatch } = createAgent();

    clickTarget();
    agent.flush();

    const clickEvent = emitBatch.mock.calls
      .flatMap((call) => {
        const [batch] = call as [Array<{ rawType?: string; payload?: Record<string, unknown> }>];
        return batch;
      })
      .find((entry) => entry.rawType === "click");

    expect(clickEvent?.payload?.target).toMatchObject({
      tag: "BUTTON"
    });
    expect(clickEvent?.payload?.target).toHaveProperty("idToken");
    expect(JSON.stringify(clickEvent?.payload?.target)).not.toContain("target");
    expect(clickEvent?.payload?.target).not.toHaveProperty("selector");

    await vi.advanceTimersByTimeAsync(0);

    expect(clickEvent?.payload?.target).toMatchObject({
      selector: expect.stringMatching(/^button\[id:t_[a-z0-9]+\]$/),
      tag: "BUTTON",
      idToken: expect.stringMatching(/^t_[a-z0-9]+$/)
    });
    expect(JSON.stringify(clickEvent?.payload?.target)).not.toContain("target");

    agent.dispose();
  });

  it("coalesces scroll bursts into leading and trailing samples", async () => {
    const { agent, emitBatch } = createAgent();

    dispatchScroll(0, 120);
    agent.flush();

    dispatchScroll(0, 240);
    dispatchScroll(0, 480);

    const immediateScrollEvents = emitBatch.mock.calls.flatMap((call) => {
      const [events] = call as [Array<{ rawType?: string; payload?: { scrollY?: number } }>];
      return events.filter((event) => event.rawType === "scroll");
    });

    expect(immediateScrollEvents).toHaveLength(1);
    expect(immediateScrollEvents[0]?.payload?.scrollY).toBe(120);

    emitBatch.mockClear();

    await vi.advanceTimersByTimeAsync(160);
    agent.flush();

    const trailingScrollEvents = emitBatch.mock.calls.flatMap((call) => {
      const [events] = call as [Array<{ rawType?: string; payload?: { scrollY?: number } }>];
      return events.filter((event) => event.rawType === "scroll");
    });

    expect(trailingScrollEvents).toHaveLength(1);
    expect(trailingScrollEvents[0]?.payload?.scrollY).toBe(480);

    agent.dispose();
  });

  it("suppresses mousemove capture during the post-scroll burst window", async () => {
    const { agent, emitBatch } = createAgent();

    dispatchScroll(0, 180);
    movePointer();
    agent.flush();

    expect(emittedRawTypes(emitBatch)).toContain("scroll");
    expect(emittedRawTypes(emitBatch)).not.toContain("mousemove");

    emitBatch.mockClear();

    await vi.advanceTimersByTimeAsync(250);
    movePointer();
    agent.flush();

    expect(emittedRawTypes(emitBatch)).toContain("mousemove");

    agent.dispose();
  });

  it("suppresses mousemove capture while the event buffer is under pressure", () => {
    const { agent, emitBatch } = createAgent();

    dispatchInjectedEvents("mutation", 130);
    movePointer();
    agent.flush();

    expect(emittedRawTypes(emitBatch)).toContain("mutation");
    expect(emittedRawTypes(emitBatch)).not.toContain("mousemove");

    agent.dispose();
  });

  it("flushes buffered low-priority events asynchronously in chunks", async () => {
    const { agent, emitBatch } = createAgent();

    dispatchInjectedEvents("mutation", 130);

    expect(emitBatch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);

    expect(emitBatch).toHaveBeenCalledTimes(1);
    expect(emitBatch.mock.calls[0]?.[0]).toHaveLength(80);

    await vi.advanceTimersToNextTimerAsync();

    expect(countEmittedEvents(emitBatch)).toBe(130);
    expect(emitBatch.mock.calls.at(-1)?.[0]).toHaveLength(50);

    agent.dispose();
  });

  it("sheds low-priority overflow before draining the backlog", () => {
    const { agent, emitBatch } = createAgent();

    dispatchInjectedEvents("mutation", 1_300);

    expect(emitBatch).not.toHaveBeenCalled();

    agent.flush();

    expect(countEmittedEvents(emitBatch)).toBeLessThan(1_000);

    agent.dispose();
  });

  it("ignores class/style churn in lite mutation observation", () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    const OriginalMutationObserver = globalThis.MutationObserver;

    class MockMutationObserver {
      public constructor(_: MutationCallback) {
        void _;
      }

      public disconnect = disconnect;

      public observe = observe;

      public takeRecords(): MutationRecord[] {
        return [];
      }
    }

    globalThis.MutationObserver = MockMutationObserver as unknown as typeof MutationObserver;

    try {
      const { agent } = createAgent();

      expect(observe).toHaveBeenCalledWith(
        document.documentElement,
        expect.objectContaining({
          attributes: true,
          childList: true,
          subtree: true,
          characterData: false,
          attributeFilter: expect.arrayContaining(["hidden", "aria-expanded", "href", "src"])
        })
      );

      const options = observe.mock.calls[0]?.[1] as { attributeFilter?: string[] } | undefined;
      expect(options?.attributeFilter).not.toContain("class");
      expect(options?.attributeFilter).not.toContain("style");

      agent.dispose();
    } finally {
      globalThis.MutationObserver = OriginalMutationObserver;
    }
  });
});
