import { describe, expect, it } from "vitest";

import { createCdpRouter } from "./router.js";
import type {
  CdpDetachHandler,
  CdpEventHandler,
  Debuggee,
  DebuggerRoot,
  DebuggerTransport,
  RawCdpEvent
} from "./types.js";

class FakeDebuggerTransport implements DebuggerTransport {
  public readonly attached: Array<{ debuggee: DebuggerRoot; version: string }> = [];

  public readonly detached: DebuggerRoot[] = [];

  public readonly commands: Array<{
    debuggee: Debuggee;
    method: string;
    params?: Record<string, unknown>;
  }> = [];

  private readonly eventListeners = new Set<CdpEventHandler>();

  private readonly detachListeners = new Set<CdpDetachHandler>();

  public async attach(debuggee: DebuggerRoot, version: string): Promise<void> {
    this.attached.push({ debuggee, version });
  }

  public async detach(debuggee: DebuggerRoot): Promise<void> {
    this.detached.push(debuggee);
  }

  public async sendCommand<TResult = unknown>(
    debuggee: Debuggee,
    method: string,
    params?: Record<string, unknown>
  ): Promise<TResult> {
    this.commands.push({ debuggee, method, params });
    return undefined as TResult;
  }

  public addEventListener(handler: CdpEventHandler): () => void {
    this.eventListeners.add(handler);

    return () => {
      this.eventListeners.delete(handler);
    };
  }

  public addDetachListener(handler: CdpDetachHandler): () => void {
    this.detachListeners.add(handler);

    return () => {
      this.detachListeners.delete(handler);
    };
  }

  public emitEvent(event: RawCdpEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  public emitDetach(tabId: number, reason: string): void {
    for (const listener of this.detachListeners) {
      listener({ tabId, reason });
    }
  }
}

describe("cdp-router", () => {
  it("attaches and enables baseline domains", async () => {
    const transport = new FakeDebuggerTransport();
    const router = createCdpRouter(transport);

    await router.attach(5);
    await router.enableBaseline(5);

    expect(transport.attached).toEqual([{ debuggee: { tabId: 5 }, version: "1.3" }]);
    expect(transport.commands.map((item) => item.method)).toEqual([
      "Network.enable",
      "Runtime.enable",
      "Log.enable",
      "Page.enable"
    ]);
  });

  it("enables auto attach using default flatten session settings", async () => {
    const transport = new FakeDebuggerTransport();
    const router = createCdpRouter(transport);

    await router.enableAutoAttach(7);

    const call = transport.commands[0];
    expect(call?.method).toBe("Target.setAutoAttach");
    expect(call?.params).toMatchObject({
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    });
  });

  it("tracks child sessions from attached and detached events", () => {
    const transport = new FakeDebuggerTransport();
    const router = createCdpRouter(transport);

    transport.emitEvent({
      tabId: 9,
      method: "Target.attachedToTarget",
      params: {
        sessionId: "CHILD-1",
        targetInfo: { targetId: "TARGET-1", type: "iframe", url: "https://example.com/frame" }
      }
    });

    const attached = router.getAttachedTargets(9);
    expect(attached).toHaveLength(1);
    expect(attached[0]?.sessionId).toBe("CHILD-1");

    transport.emitEvent({
      tabId: 9,
      method: "Target.detachedFromTarget",
      params: {
        sessionId: "CHILD-1"
      }
    });

    expect(router.getAttachedTargets(9)).toHaveLength(0);
  });

  it("forwards detach events to listeners", () => {
    const transport = new FakeDebuggerTransport();
    const router = createCdpRouter(transport);
    let reason = "";

    const unsubscribe = router.onDetach((event) => {
      reason = event.reason;
    });

    transport.emitDetach(2, "target_closed");
    unsubscribe();

    expect(reason).toBe("target_closed");
  });
});
