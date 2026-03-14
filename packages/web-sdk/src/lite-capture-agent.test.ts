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
import type { LiteCaptureState } from "./types.js";

function createAgent(state: Partial<LiteCaptureState> = {}) {
  const emitBatch = vi.fn();
  const agent = new LiteCaptureAgent({
    emitBatch,
    showIndicator: false
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

function movePointer(): void {
  document.dispatchEvent(
    new MouseEvent("pointermove", {
      bubbles: true,
      clientX: 12,
      clientY: 18
    })
  );
}

function countEmittedEvents(emitBatch: ReturnType<typeof vi.fn>): number {
  return emitBatch.mock.calls.reduce((total, call) => {
    const [events] = call as [Array<unknown>];
    return total + (Array.isArray(events) ? events.length : 0);
  }, 0);
}

describe("LiteCaptureAgent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `<button id="target" type="button">Open</button>`;
    snapdomToBlobMock.mockImplementation(() => new Promise(() => undefined));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("defers action screenshots off the click task", async () => {
    const { agent, emitBatch } = createAgent();

    clickTarget();

    expect(snapdomToBlobMock).not.toHaveBeenCalled();
    expect(emitBatch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);

    expect(snapdomToBlobMock).toHaveBeenCalledTimes(1);

    agent.dispose();
  });

  it("defers start capture until the page is idle", async () => {
    const { agent } = createAgent();

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

  it("emits a final localStorage snapshot when stopping before idle storage capture runs", () => {
    localStorage.setItem("demo", "value");
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

    expect(emittedRawTypes).toContain("localStorageSnapshot");

    agent.dispose();
  });

  it("flushes buffered low-priority events asynchronously in chunks", async () => {
    const { agent, emitBatch } = createAgent();

    dispatchInjectedEvents("mutation", 130);

    expect(emitBatch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);

    expect(emitBatch).toHaveBeenCalledTimes(1);
    expect(emitBatch.mock.calls[0]?.[0]).toHaveLength(120);

    await vi.advanceTimersToNextTimerAsync();

    expect(countEmittedEvents(emitBatch)).toBe(130);
    expect(emitBatch.mock.calls.at(-1)?.[0]).toHaveLength(10);

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
