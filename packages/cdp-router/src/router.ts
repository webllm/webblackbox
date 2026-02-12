import type {
  AutoAttachOptions,
  CdpDetachHandler,
  CdpEventHandler,
  Debuggee,
  DebuggerChild,
  DebuggerRoot,
  DebuggerTransport,
  RawCdpEvent,
  RouterAttachedTarget
} from "./types.js";

const BASELINE_DOMAINS = ["Network.enable", "Runtime.enable", "Log.enable", "Page.enable"] as const;

const DEFAULT_AUTO_ATTACH_OPTIONS: AutoAttachOptions = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [
    { type: "iframe", exclude: false },
    { type: "worker", exclude: false },
    { type: "service_worker", exclude: false }
  ]
};

export interface CdpRouter {
  attach(tabId: number, protocolVersion?: "1.3" | "1.2"): Promise<void>;
  detach(tabId: number): Promise<void>;
  send<TResult = unknown>(
    target: Debuggee,
    method: string,
    params?: Record<string, unknown>
  ): Promise<TResult>;
  enableBaseline(tabId: number, sessionId?: string): Promise<void>;
  enableAutoAttach(
    tabId: number,
    options?: Partial<AutoAttachOptions>,
    sessionId?: string
  ): Promise<void>;
  getAttachedTargets(tabId: number): RouterAttachedTarget[];
  onEvent(callback: CdpEventHandler): () => void;
  onDetach(callback: CdpDetachHandler): () => void;
  dispose(): void;
}

type SessionMap = Map<string, RouterAttachedTarget>;

export class DefaultCdpRouter implements CdpRouter {
  private readonly eventListeners = new Set<CdpEventHandler>();

  private readonly detachListeners = new Set<CdpDetachHandler>();

  private readonly sessionsByTab = new Map<number, SessionMap>();

  private readonly transportUnsubscribe: Array<() => void>;

  public constructor(private readonly transport: DebuggerTransport) {
    this.transportUnsubscribe = [
      this.transport.addEventListener((event) => {
        this.trackAttachedTargets(event);

        for (const listener of this.eventListeners) {
          listener(event);
        }
      }),
      this.transport.addDetachListener((event) => {
        this.sessionsByTab.delete(event.tabId);

        for (const listener of this.detachListeners) {
          listener(event);
        }
      })
    ];
  }

  public async attach(tabId: number, protocolVersion: "1.3" | "1.2" = "1.3"): Promise<void> {
    await this.transport.attach({ tabId }, protocolVersion);
    this.ensureSessionMap(tabId);
  }

  public async detach(tabId: number): Promise<void> {
    await this.transport.detach({ tabId });
    this.sessionsByTab.delete(tabId);
  }

  public async send<TResult = unknown>(
    target: Debuggee,
    method: string,
    params?: Record<string, unknown>
  ): Promise<TResult> {
    return this.transport.sendCommand<TResult>(target, method, params);
  }

  public async enableBaseline(tabId: number, sessionId?: string): Promise<void> {
    const target: DebuggerRoot | DebuggerChild = sessionId ? { tabId, sessionId } : { tabId };

    for (const method of BASELINE_DOMAINS) {
      await this.send(target, method);
    }
  }

  public async enableAutoAttach(
    tabId: number,
    options: Partial<AutoAttachOptions> = {},
    sessionId?: string
  ): Promise<void> {
    const params: AutoAttachOptions = {
      ...DEFAULT_AUTO_ATTACH_OPTIONS,
      ...options
    };

    const target: DebuggerRoot | DebuggerChild = sessionId ? { tabId, sessionId } : { tabId };

    await this.send(target, "Target.setAutoAttach", params as unknown as Record<string, unknown>);
  }

  public getAttachedTargets(tabId: number): RouterAttachedTarget[] {
    const sessions = this.sessionsByTab.get(tabId);

    if (!sessions) {
      return [];
    }

    return [...sessions.values()];
  }

  public onEvent(callback: CdpEventHandler): () => void {
    this.eventListeners.add(callback);

    return () => {
      this.eventListeners.delete(callback);
    };
  }

  public onDetach(callback: CdpDetachHandler): () => void {
    this.detachListeners.add(callback);

    return () => {
      this.detachListeners.delete(callback);
    };
  }

  public dispose(): void {
    for (const unsubscribe of this.transportUnsubscribe) {
      unsubscribe();
    }

    this.eventListeners.clear();
    this.detachListeners.clear();
    this.sessionsByTab.clear();
  }

  private ensureSessionMap(tabId: number): SessionMap {
    const existing = this.sessionsByTab.get(tabId);

    if (existing) {
      return existing;
    }

    const next = new Map<string, RouterAttachedTarget>();
    this.sessionsByTab.set(tabId, next);
    return next;
  }

  private trackAttachedTargets(event: RawCdpEvent): void {
    if (event.method === "Target.attachedToTarget") {
      const params = event.params as {
        sessionId?: string;
        targetInfo?: {
          targetId?: string;
          type?: string;
          url?: string;
        };
      };

      const childSessionId = params.sessionId;

      if (!childSessionId) {
        return;
      }

      const sessions = this.ensureSessionMap(event.tabId);
      sessions.set(childSessionId, {
        tabId: event.tabId,
        sessionId: childSessionId,
        targetId: params.targetInfo?.targetId,
        targetType: params.targetInfo?.type,
        url: params.targetInfo?.url
      });
      return;
    }

    if (event.method === "Target.detachedFromTarget") {
      const params = event.params as {
        sessionId?: string;
      };

      if (!params.sessionId) {
        return;
      }

      const sessions = this.sessionsByTab.get(event.tabId);
      sessions?.delete(params.sessionId);
    }
  }
}

export function createCdpRouter(transport: DebuggerTransport): CdpRouter {
  return new DefaultCdpRouter(transport);
}
