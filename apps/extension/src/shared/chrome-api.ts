export type PortMessageHandler = (message: unknown) => void;

export type PortDisconnectHandler = () => void;

export type InjectionResult<TResult = unknown> = {
  documentId?: string;
  error?: string;
  frameId: number;
  result?: TResult;
};

export type ScriptInjectionTarget = {
  allFrames?: boolean;
  documentIds?: string[];
  frameIds?: number[];
  tabId: number;
};

export type MessageSenderLike = {
  documentId?: string;
  frameId?: number;
  url?: string;
  origin?: string;
  tab?: {
    id?: number;
    url?: string;
  };
};

export type PortLike = {
  name: string;
  sender?: MessageSenderLike;
  onMessage: {
    addListener(handler: PortMessageHandler): void;
    removeListener(handler: PortMessageHandler): void;
  };
  onDisconnect: {
    addListener(handler: PortDisconnectHandler): void;
    removeListener(handler: PortDisconnectHandler): void;
  };
  postMessage(message: unknown): void;
  disconnect?: () => void;
};

export type ChromeApi = {
  alarms?: {
    create(name: string, alarmInfo: { when: number }): void | Promise<void>;
    clear(name: string): boolean | Promise<boolean>;
    getAll?(): Promise<Array<{ name: string; scheduledTime?: number }>>;
    onAlarm: {
      addListener(callback: (alarm: { name: string; scheduledTime?: number }) => void): void;
    };
  };
  action?: {
    setBadgeText(details: { text: string }): Promise<void>;
    setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  };
  commands?: {
    onCommand: {
      addListener(callback: (command: string) => void): void;
    };
  };
  debugger?: {
    attach(target: { tabId: number }, version: string): Promise<void>;
    detach(target: { tabId: number }): Promise<void>;
    sendCommand<TResult = unknown>(
      target: { tabId: number; sessionId?: string },
      method: string,
      params?: Record<string, unknown>
    ): Promise<TResult>;
    onEvent: {
      addListener(
        callback: (
          source: { tabId: number; sessionId?: string },
          method: string,
          params: unknown
        ) => void
      ): void;
      removeListener(
        callback: (
          source: { tabId: number; sessionId?: string },
          method: string,
          params: unknown
        ) => void
      ): void;
    };
    onDetach: {
      addListener(callback: (source: { tabId: number }, reason: string) => void): void;
      removeListener(callback: (source: { tabId: number }, reason: string) => void): void;
    };
  };
  downloads?: {
    download(options: { url: string; filename: string; saveAs?: boolean }): Promise<number>;
  };
  i18n?: {
    getMessage?(messageName: string): string;
    getUILanguage(): string;
  };
  offscreen?: {
    createDocument(options: {
      url: string;
      reasons: string[];
      justification: string;
    }): Promise<void>;
    closeDocument(): Promise<void>;
  };
  tabCapture?: {
    getMediaStreamId(options?: { targetTabId?: number; consumerTabId?: number }): Promise<string>;
  };
  runtime?: {
    connect(connectInfo: { name: string }): PortLike;
    getManifest?: () => {
      version?: string;
      permissions?: string[];
      content_scripts?: Array<{ js?: string[] }>;
      host_permissions?: string[];
    };
    getURL(path: string): string;
    getContexts?: (options: {
      contextTypes: string[];
      documentUrls?: string[];
    }) => Promise<unknown[]>;
    onConnect: {
      addListener(callback: (port: PortLike) => void): void;
    };
    onInstalled: {
      addListener(callback: () => void): void;
    };
    onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSenderLike,
          sendResponse: (response: unknown) => void
        ) => boolean | void
      ): void;
    };
    sendMessage(message: unknown): Promise<unknown>;
  };
  webNavigation?: {
    getAllFrames?: (details: { tabId: number }) => Promise<
      Array<{
        frameId: number;
        parentFrameId: number;
        documentId?: string;
        parentDocumentId?: string;
        url: string;
      }>
    >;
    onCommitted: {
      addListener(
        callback: (details: {
          tabId: number;
          frameId: number;
          documentId?: string;
          documentLifecycle?: "prerender" | "active" | "cached" | "pending_deletion";
          frameType?: "outermost_frame" | "fenced_frame" | "sub_frame";
          parentDocumentId?: string;
          parentFrameId?: number;
          url: string;
          timeStamp?: number;
        }) => void
      ): void;
      removeListener(
        callback: (details: {
          tabId: number;
          frameId: number;
          documentId?: string;
          documentLifecycle?: "prerender" | "active" | "cached" | "pending_deletion";
          frameType?: "outermost_frame" | "fenced_frame" | "sub_frame";
          parentDocumentId?: string;
          parentFrameId?: number;
          url: string;
          timeStamp?: number;
        }) => void
      ): void;
    };
    onHistoryStateUpdated?: {
      addListener(
        callback: (details: {
          tabId: number;
          frameId: number;
          documentId?: string;
          parentDocumentId?: string;
          parentFrameId?: number;
          url: string;
          timeStamp?: number;
        }) => void
      ): void;
      removeListener(
        callback: (details: {
          tabId: number;
          frameId: number;
          documentId?: string;
          parentDocumentId?: string;
          parentFrameId?: number;
          url: string;
          timeStamp?: number;
        }) => void
      ): void;
    };
    onReferenceFragmentUpdated?: {
      addListener(
        callback: (details: {
          tabId: number;
          frameId: number;
          documentId?: string;
          parentDocumentId?: string;
          parentFrameId?: number;
          url: string;
          timeStamp?: number;
        }) => void
      ): void;
      removeListener(
        callback: (details: {
          tabId: number;
          frameId: number;
          documentId?: string;
          parentDocumentId?: string;
          parentFrameId?: number;
          url: string;
          timeStamp?: number;
        }) => void
      ): void;
    };
  };
  webRequest?: {
    onBeforeRequest: {
      addListener(
        callback: (details: {
          requestId: string;
          tabId: number;
          documentId?: string;
          frameId?: number;
          parentDocumentId?: string;
          parentFrameId?: number;
          method?: string;
          type?: string;
          url: string;
          timeStamp?: number;
        }) => void,
        filter: { urls: string[] }
      ): void;
      removeListener(
        callback: (details: {
          requestId: string;
          tabId: number;
          documentId?: string;
          frameId?: number;
          method?: string;
          type?: string;
          url: string;
          timeStamp?: number;
        }) => void
      ): void;
    };
    onCompleted: {
      addListener(
        callback: (details: {
          requestId: string;
          tabId: number;
          documentId?: string;
          frameId?: number;
          method?: string;
          type?: string;
          url: string;
          statusCode?: number;
          statusLine?: string;
          timeStamp?: number;
        }) => void,
        filter: { urls: string[] }
      ): void;
      removeListener(
        callback: (details: {
          requestId: string;
          tabId: number;
          documentId?: string;
          frameId?: number;
          method?: string;
          type?: string;
          url: string;
          statusCode?: number;
          statusLine?: string;
          timeStamp?: number;
        }) => void
      ): void;
    };
    onErrorOccurred: {
      addListener(
        callback: (details: {
          requestId: string;
          tabId: number;
          documentId?: string;
          frameId?: number;
          method?: string;
          type?: string;
          url: string;
          error?: string;
          timeStamp?: number;
        }) => void,
        filter: { urls: string[] }
      ): void;
      removeListener(
        callback: (details: {
          requestId: string;
          tabId: number;
          documentId?: string;
          frameId?: number;
          method?: string;
          type?: string;
          url: string;
          error?: string;
          timeStamp?: number;
        }) => void
      ): void;
    };
  };
  scripting?: {
    executeScript<TResult = unknown>(options: {
      target: ScriptInjectionTarget;
      world?: "MAIN" | "ISOLATED";
      files?: string[];
      func?: (...args: never[]) => unknown;
      args?: unknown[];
      injectImmediately?: boolean;
    }): Promise<InjectionResult<TResult>[]>;
  };
  storage?: {
    local: {
      get(
        keys?: string[] | string | Record<string, unknown> | null
      ): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
    managed?: {
      get(
        keys?: string[] | string | Record<string, unknown> | null
      ): Promise<Record<string, unknown>>;
    };
  };
  tabs?: {
    create(createProperties: { url?: string; active?: boolean }): Promise<{
      id?: number;
      active?: boolean;
      url?: string;
      title?: string;
      lastAccessed?: number;
    }>;
    get(tabId: number): Promise<{
      id?: number;
      active?: boolean;
      url?: string;
      title?: string;
      lastAccessed?: number;
    }>;
    query(queryInfo: {
      active?: boolean;
      currentWindow?: boolean;
      lastFocusedWindow?: boolean;
    }): Promise<
      Array<{
        id?: number;
        active?: boolean;
        url?: string;
        title?: string;
        lastAccessed?: number;
      }>
    >;
    onUpdated?: {
      addListener(
        callback: (
          tabId: number,
          changeInfo: {
            status?: "loading" | "complete";
            url?: string;
          }
        ) => void
      ): void;
    };
    onRemoved?: {
      addListener(callback: (tabId: number) => void): void;
    };
    reload?(tabId: number, reloadProperties?: { bypassCache?: boolean }): Promise<void>;
    sendMessage(
      tabId: number,
      message: unknown,
      options?: { documentId?: string; frameId?: number }
    ): Promise<unknown>;
  };
};

export function getChromeApi(): ChromeApi | null {
  const chromeApi = (globalThis as { chrome?: ChromeApi }).chrome;
  return chromeApi ?? null;
}
