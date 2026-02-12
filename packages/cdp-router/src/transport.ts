import type {
  CdpDetachHandler,
  CdpEventHandler,
  Debuggee,
  DebuggerRoot,
  DebuggerTransport
} from "./types.js";

type ChromeLike = {
  debugger?: {
    attach(target: DebuggerRoot, version: string): Promise<void>;
    detach(target: DebuggerRoot): Promise<void>;
    sendCommand<TResult = unknown>(
      target: Debuggee,
      method: string,
      params?: Record<string, unknown>
    ): Promise<TResult>;
    onEvent: {
      addListener(callback: (source: Debuggee, method: string, params: unknown) => void): void;
      removeListener(callback: (source: Debuggee, method: string, params: unknown) => void): void;
    };
    onDetach: {
      addListener(callback: (source: Debuggee, reason: string) => void): void;
      removeListener(callback: (source: Debuggee, reason: string) => void): void;
    };
  };
};

function getChromeDebugger(): NonNullable<ChromeLike["debugger"]> {
  const chromeApi = (globalThis as { chrome?: ChromeLike }).chrome;

  if (!chromeApi?.debugger) {
    throw new Error("chrome.debugger is unavailable in this runtime");
  }

  return chromeApi.debugger;
}

export function createChromeDebuggerTransport(): DebuggerTransport {
  const chromeDebugger = getChromeDebugger();

  return {
    attach(debuggee: DebuggerRoot, version: string) {
      return chromeDebugger.attach(debuggee, version);
    },
    detach(debuggee: DebuggerRoot) {
      return chromeDebugger.detach(debuggee);
    },
    sendCommand<TResult = unknown>(
      debuggee: Debuggee,
      method: string,
      params?: Record<string, unknown>
    ): Promise<TResult> {
      return chromeDebugger.sendCommand<TResult>(debuggee, method, params);
    },
    addEventListener(handler: CdpEventHandler): () => void {
      const listener = (source: Debuggee, method: string, params: unknown) => {
        handler({
          tabId: source.tabId,
          sessionId: "sessionId" in source ? source.sessionId : undefined,
          method,
          params
        });
      };

      chromeDebugger.onEvent.addListener(listener);

      return () => {
        chromeDebugger.onEvent.removeListener(listener);
      };
    },
    addDetachListener(handler: CdpDetachHandler): () => void {
      const listener = (source: Debuggee, reason: string) => {
        handler({ tabId: source.tabId, reason });
      };

      chromeDebugger.onDetach.addListener(listener);

      return () => {
        chromeDebugger.onDetach.removeListener(listener);
      };
    }
  };
}
