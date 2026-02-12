export type DebuggerRoot = {
  tabId: number;
};

export type DebuggerChild = {
  tabId: number;
  sessionId: string;
};

export type Debuggee = DebuggerRoot | DebuggerChild;

export type RawCdpEvent = {
  tabId: number;
  sessionId?: string;
  method: string;
  params?: unknown;
};

export type DetachInfo = {
  tabId: number;
  reason: string;
};

export type CdpEventHandler = (event: RawCdpEvent) => void;

export type CdpDetachHandler = (event: DetachInfo) => void;

export type DebuggerTransport = {
  attach(debuggee: DebuggerRoot, version: string): Promise<void>;
  detach(debuggee: DebuggerRoot): Promise<void>;
  sendCommand<TResult = unknown>(
    debuggee: Debuggee,
    method: string,
    params?: Record<string, unknown>
  ): Promise<TResult>;
  addEventListener(handler: CdpEventHandler): () => void;
  addDetachListener(handler: CdpDetachHandler): () => void;
};

export type AutoAttachOptions = {
  autoAttach: boolean;
  waitForDebuggerOnStart: boolean;
  flatten: boolean;
  filter?: Array<{ type: string; exclude: boolean }>;
};

export type RouterAttachedTarget = {
  tabId: number;
  sessionId?: string;
  targetId?: string;
  frameId?: string;
  targetType?: string;
  url?: string;
};
