import type { PortLike } from "../shared/chrome-api.js";

export type ResilientRuntimePortOptions = {
  connect: () => PortLike;
  onMessage: (message: unknown) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  onDisconnectDeadline: () => void;
  reconnectInitialMs: number;
  reconnectMaxMs: number;
  disconnectDeadlineMs: number;
};

type BoundPort = {
  port: PortLike;
  onMessage: (message: unknown) => void;
  onDisconnect: () => void;
};

/** Keeps an offscreen document attached across service-worker restarts. */
export class ResilientRuntimePort {
  private bound: BoundPort | null = null;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private disconnectDeadlineTimer: ReturnType<typeof setTimeout> | null = null;

  private reconnectAttempts = 0;

  private stopped = true;

  public constructor(private readonly options: ResilientRuntimePortOptions) {}

  public start(): void {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.connect();
  }

  public stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearDisconnectDeadline();
    this.reconnectAttempts = 0;

    const bound = this.bound;
    if (!bound) {
      return;
    }

    this.unbind(bound);
    this.bound = null;
    try {
      bound.port.disconnect?.();
    } catch {
      void 0;
    }
  }

  public post(message: unknown): boolean {
    const bound = this.bound;
    if (!bound) {
      return false;
    }

    try {
      bound.port.postMessage(message);
      return true;
    } catch {
      this.handleDisconnect(bound);
      return false;
    }
  }

  private connect(): void {
    if (this.stopped || this.bound) {
      return;
    }

    try {
      const port = this.options.connect();
      const bound: BoundPort = {
        port,
        onMessage: (message) => this.options.onMessage(message),
        onDisconnect: () => this.handleDisconnect(bound)
      };
      port.onMessage.addListener(bound.onMessage);
      port.onDisconnect.addListener(bound.onDisconnect);
      this.bound = bound;
      this.reconnectAttempts = 0;
      this.clearReconnectTimer();
      this.clearDisconnectDeadline();
      this.options.onConnected();
    } catch {
      this.scheduleReconnect();
    }
  }

  private handleDisconnect(bound: BoundPort): void {
    if (this.bound !== bound) {
      return;
    }

    this.unbind(bound);
    this.bound = null;
    this.options.onDisconnected();
    this.scheduleDisconnectDeadline();
    this.scheduleReconnect();
  }

  private unbind(bound: BoundPort): void {
    bound.port.onMessage.removeListener(bound.onMessage);
    bound.port.onDisconnect.removeListener(bound.onDisconnect);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.bound || this.reconnectTimer !== null) {
      return;
    }

    const exponent = Math.min(this.reconnectAttempts, 8);
    const delay = Math.min(
      this.options.reconnectInitialMs * 2 ** exponent,
      this.options.reconnectMaxMs
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private scheduleDisconnectDeadline(): void {
    if (this.stopped || this.disconnectDeadlineTimer !== null) {
      return;
    }

    this.disconnectDeadlineTimer = setTimeout(() => {
      this.disconnectDeadlineTimer = null;
      if (!this.bound && !this.stopped) {
        this.options.onDisconnectDeadline();
      }
    }, this.options.disconnectDeadlineMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) {
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearDisconnectDeadline(): void {
    if (this.disconnectDeadlineTimer === null) {
      return;
    }

    clearTimeout(this.disconnectDeadlineTimer);
    this.disconnectDeadlineTimer = null;
  }
}
