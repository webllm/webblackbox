type CapturePayload = Record<string, unknown>;

const FLAG = "__WEBBLACKBOX_INJECTED__";
const windowFlags = window as unknown as Record<string, unknown>;

if (!windowFlags[FLAG]) {
  windowFlags[FLAG] = true;

  installConsoleHooks();
  installErrorHooks();
  installStorageHooks();
  installNetworkHooks();
  installIndexedDbHooks();

  emit("notice", {
    message: "injected-ready",
    href: location.href
  });
}

function emit(rawType: string, payload: CapturePayload): void {
  window.postMessage(
    {
      source: "webblackbox-injected",
      kind: "capture-event",
      rawType,
      payload,
      t: Date.now(),
      mono: monotonicTime()
    },
    "*"
  );
}

function monotonicTime(): number {
  return performance.timeOrigin + performance.now();
}

function installConsoleHooks(): void {
  const consoleLevels = ["log", "info", "warn", "error", "debug"] as const;
  const consoleRecord = console as unknown as Record<string, (...args: unknown[]) => unknown>;

  for (const level of consoleLevels) {
    const original = consoleRecord[level];

    if (typeof original !== "function") {
      continue;
    }

    consoleRecord[level] = (...args: unknown[]) => {
      emit("console", {
        level,
        args: args.map((value) => safeSerialize(value))
      });

      return Reflect.apply(original, console, args);
    };
  }
}

function installErrorHooks(): void {
  window.addEventListener("error", (event) => {
    const target = event.target;

    if (target instanceof HTMLElement && ["SCRIPT", "LINK", "IMG"].includes(target.tagName)) {
      emit("resourceError", {
        tag: target.tagName,
        url: readTargetUrl(target)
      });
      return;
    }

    emit("pageError", {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error instanceof Error ? event.error.stack : undefined
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    emit("unhandledrejection", {
      reason: safeSerialize(event.reason)
    });
  });
}

function installStorageHooks(): void {
  try {
    const localSetItem = localStorage.setItem.bind(localStorage);
    const localRemoveItem = localStorage.removeItem.bind(localStorage);
    const localClear = localStorage.clear.bind(localStorage);

    localStorage.setItem = (key: string, value: string) => {
      emit("localStorageOp", {
        op: "setItem",
        key,
        valueLength: value.length
      });

      localSetItem(key, value);
    };

    localStorage.removeItem = (key: string) => {
      emit("localStorageOp", {
        op: "removeItem",
        key
      });

      localRemoveItem(key);
    };

    localStorage.clear = () => {
      emit("localStorageOp", {
        op: "clear"
      });

      localClear();
    };
  } catch {
    emit("notice", { message: "localStorage-hook-failed" });
  }

  try {
    const sessionSetItem = sessionStorage.setItem.bind(sessionStorage);
    const sessionRemoveItem = sessionStorage.removeItem.bind(sessionStorage);
    const sessionClear = sessionStorage.clear.bind(sessionStorage);

    sessionStorage.setItem = (key: string, value: string) => {
      emit("sessionStorageOp", {
        op: "setItem",
        key,
        valueLength: value.length
      });

      sessionSetItem(key, value);
    };

    sessionStorage.removeItem = (key: string) => {
      emit("sessionStorageOp", {
        op: "removeItem",
        key
      });

      sessionRemoveItem(key);
    };

    sessionStorage.clear = () => {
      emit("sessionStorageOp", {
        op: "clear"
      });

      sessionClear();
    };
  } catch {
    emit("notice", { message: "sessionStorage-hook-failed" });
  }
}

function installNetworkHooks(): void {
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const request = args[0];
    const requestUrl =
      request instanceof Request
        ? request.url
        : typeof request === "string"
          ? request
          : request instanceof URL
            ? request.toString()
            : "unknown";
    const method = request instanceof Request ? request.method : "GET";
    const started = performance.now();

    emit("fetch", {
      phase: "start",
      method,
      url: requestUrl
    });

    try {
      const response = await originalFetch(...args);

      emit("fetch", {
        phase: "end",
        method,
        url: requestUrl,
        status: response.status,
        ok: response.ok,
        duration: performance.now() - started
      });

      return response;
    } catch (error) {
      emit("fetchError", {
        method,
        url: requestUrl,
        duration: performance.now() - started,
        message: error instanceof Error ? error.message : String(error)
      });

      throw error;
    }
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ): void {
    (
      this as XMLHttpRequest & { __wbMethod?: string; __wbUrl?: string; __wbStarted?: number }
    ).__wbMethod = method;
    (
      this as XMLHttpRequest & { __wbMethod?: string; __wbUrl?: string; __wbStarted?: number }
    ).__wbUrl = typeof url === "string" ? url : url.toString();

    xhrOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
    const xhr = this as XMLHttpRequest & {
      __wbMethod?: string;
      __wbUrl?: string;
      __wbStarted?: number;
    };
    xhr.__wbStarted = performance.now();

    emit("xhr", {
      phase: "start",
      method: xhr.__wbMethod ?? "GET",
      url: xhr.__wbUrl ?? "unknown",
      bodyLength: typeof body === "string" ? body.length : undefined
    });

    this.addEventListener("loadend", () => {
      emit("xhr", {
        phase: "end",
        method: xhr.__wbMethod ?? "GET",
        url: xhr.__wbUrl ?? "unknown",
        status: this.status,
        duration: performance.now() - (xhr.__wbStarted ?? performance.now())
      });
    });

    xhrSend.call(this, body as unknown as XMLHttpRequestBodyInit | null | undefined);
  };

  if (
    typeof window.EventSource === "function" &&
    !windowFlags.__WEBBLACKBOX_EVENTSOURCE_PATCHED__
  ) {
    const NativeEventSource = window.EventSource;

    class WebBlackboxEventSource extends NativeEventSource {
      public constructor(...args: ConstructorParameters<typeof NativeEventSource>) {
        super(...args);

        const url = typeof args[0] === "string" ? args[0] : String(args[0]);

        emit("sse", {
          phase: "open",
          url
        });

        this.addEventListener("message", (event) => {
          emit("sse", {
            phase: "message",
            url,
            eventType: event.type,
            lastEventId: event.lastEventId,
            data:
              typeof event.data === "string" ? event.data.slice(0, 800) : safeSerialize(event.data)
          });
        });

        this.addEventListener("error", () => {
          emit("sse", {
            phase: "error",
            url,
            readyState: this.readyState
          });
        });
      }
    }

    window.EventSource = WebBlackboxEventSource as typeof EventSource;
    windowFlags.__WEBBLACKBOX_EVENTSOURCE_PATCHED__ = true;
  }
}

function installIndexedDbHooks(): void {
  const prototype = IDBObjectStore.prototype as IDBObjectStore & {
    _wbPatched?: boolean;
  };

  if (prototype._wbPatched) {
    return;
  }

  prototype._wbPatched = true;

  wrapObjectStoreMethod("put", (store, args) => {
    emit("indexedDbOp", {
      op: "put",
      db: store.transaction.db.name,
      store: store.name,
      key: safeSerialize(args[1])
    });
  });

  wrapObjectStoreMethod("add", (store, args) => {
    emit("indexedDbOp", {
      op: "add",
      db: store.transaction.db.name,
      store: store.name,
      key: safeSerialize(args[1])
    });
  });

  wrapObjectStoreMethod("delete", (store, args) => {
    emit("indexedDbOp", {
      op: "delete",
      db: store.transaction.db.name,
      store: store.name,
      key: safeSerialize(args[0])
    });
  });

  wrapObjectStoreMethod("clear", (store) => {
    emit("indexedDbOp", {
      op: "clear",
      db: store.transaction.db.name,
      store: store.name
    });
  });
}

function wrapObjectStoreMethod(
  method: "put" | "add" | "delete" | "clear",
  beforeCall: (store: IDBObjectStore, args: unknown[]) => void
): void {
  const storePrototype = IDBObjectStore.prototype as unknown as Record<
    string,
    (...args: unknown[]) => IDBRequest
  >;
  const original = storePrototype[method];

  if (!original) {
    return;
  }

  storePrototype[method] = function (this: IDBObjectStore, ...args: unknown[]): IDBRequest {
    beforeCall(this, args);
    return Reflect.apply(original, this, args) as IDBRequest;
  };
}

function safeSerialize(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return value.slice(0, 300);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((entry) => safeSerialize(entry));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
      output[key] = safeSerialize(entry);
    }

    return output;
  }

  return String(value);
}

function readTargetUrl(target: HTMLElement): string | undefined {
  if (target instanceof HTMLScriptElement) {
    return target.src;
  }

  if (target instanceof HTMLLinkElement) {
    return target.href;
  }

  if (target instanceof HTMLImageElement) {
    return target.src;
  }

  return undefined;
}
