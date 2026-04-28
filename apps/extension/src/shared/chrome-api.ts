export type PortMessageHandler = (message: unknown) => void;

export type PortDisconnectHandler = () => void;

export type PortLike = {
  name: string;
  sender?: {
    frameId?: number;
    tab?: {
      id?: number;
    };
  };
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
  runtime?: {
    connect(connectInfo: { name: string }): PortLike;
    getManifest?: () => {
      version?: string;
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
          sender: { tab?: { id?: number }; frameId?: number },
          sendResponse: (response: unknown) => void
        ) => boolean | void
      ): void;
    };
    sendMessage(message: unknown): Promise<unknown>;
  };
  webRequest?: {
    onBeforeRequest: {
      addListener(
        callback: (details: {
          requestId: string;
          tabId: number;
          frameId?: number;
          method?: string;
          url: string;
          timeStamp?: number;
        }) => void,
        filter: { urls: string[] }
      ): void;
      removeListener(
        callback: (details: {
          requestId: string;
          tabId: number;
          frameId?: number;
          method?: string;
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
          frameId?: number;
          method?: string;
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
          frameId?: number;
          method?: string;
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
          frameId?: number;
          method?: string;
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
          frameId?: number;
          method?: string;
          url: string;
          error?: string;
          timeStamp?: number;
        }) => void
      ): void;
    };
  };
  scripting?: {
    executeScript(options: {
      target: { tabId: number; allFrames?: boolean };
      world?: "MAIN" | "ISOLATED";
      files?: string[];
    }): Promise<void>;
  };
  storage?: {
    local: {
      get(
        keys?: string[] | string | Record<string, unknown> | null
      ): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
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
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
};

export function getChromeApi(): ChromeApi | null {
  const chromeApi = (globalThis as { chrome?: ChromeApi }).chrome;
  return chromeApi ?? null;
}
