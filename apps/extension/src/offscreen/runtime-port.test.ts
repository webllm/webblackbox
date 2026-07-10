import { describe, expect, it, vi } from "vitest";

import type { PortDisconnectHandler, PortLike, PortMessageHandler } from "../shared/chrome-api.js";
import { ResilientRuntimePort } from "./runtime-port.js";

class FakePort implements PortLike {
  public readonly name = "webblackbox:offscreen";

  public readonly messages: unknown[] = [];

  private readonly messageHandlers = new Set<PortMessageHandler>();

  private readonly disconnectHandlers = new Set<PortDisconnectHandler>();

  public readonly onMessage = {
    addListener: (handler: PortMessageHandler) => this.messageHandlers.add(handler),
    removeListener: (handler: PortMessageHandler) => this.messageHandlers.delete(handler)
  };

  public readonly onDisconnect = {
    addListener: (handler: PortDisconnectHandler) => this.disconnectHandlers.add(handler),
    removeListener: (handler: PortDisconnectHandler) => this.disconnectHandlers.delete(handler)
  };

  public postMessage(message: unknown): void {
    this.messages.push(message);
  }

  public emitMessage(message: unknown): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  public emitDisconnect(): void {
    for (const handler of [...this.disconnectHandlers]) {
      handler();
    }
  }
}

describe("ResilientRuntimePort", () => {
  it("reconnects after a service-worker port disconnect before the safety deadline", async () => {
    vi.useFakeTimers();
    const first = new FakePort();
    const second = new FakePort();
    const ports = [first, second];
    const onMessage = vi.fn();
    const onConnected = vi.fn();
    const onDisconnected = vi.fn();
    const onDisconnectDeadline = vi.fn();
    const manager = new ResilientRuntimePort({
      connect: () => ports.shift() ?? new FakePort(),
      onMessage,
      onConnected,
      onDisconnected,
      onDisconnectDeadline,
      reconnectInitialMs: 250,
      reconnectMaxMs: 1_000,
      disconnectDeadlineMs: 3_000
    });

    manager.start();
    expect(onConnected).toHaveBeenCalledTimes(1);
    first.emitMessage({ ready: true });
    expect(onMessage).toHaveBeenCalledWith({ ready: true });

    first.emitDisconnect();
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(manager.post({ lost: false })).toBe(false);

    await vi.advanceTimersByTimeAsync(250);
    expect(onConnected).toHaveBeenCalledTimes(2);
    expect(manager.post({ recovered: true })).toBe(true);
    expect(second.messages).toContainEqual({ recovered: true });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onDisconnectDeadline).not.toHaveBeenCalled();
    manager.stop();
    vi.useRealTimers();
  });

  it("fires one fail-closed deadline while reconnect attempts remain bounded", async () => {
    vi.useFakeTimers();
    const first = new FakePort();
    let attempts = 0;
    const onDisconnectDeadline = vi.fn();
    const manager = new ResilientRuntimePort({
      connect: () => {
        attempts += 1;
        if (attempts === 1) {
          return first;
        }
        throw new Error("worker unavailable");
      },
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onDisconnectDeadline,
      reconnectInitialMs: 100,
      reconnectMaxMs: 400,
      disconnectDeadlineMs: 1_000
    });

    manager.start();
    first.emitDisconnect();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onDisconnectDeadline).toHaveBeenCalledTimes(1);
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(5);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onDisconnectDeadline).toHaveBeenCalledTimes(1);
    manager.stop();
    vi.useRealTimers();
  });
});
