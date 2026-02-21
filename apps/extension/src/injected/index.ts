type CapturePayload = Record<string, unknown>;

const FLAG = "__WEBBLACKBOX_INJECTED__";
const windowFlags = window as unknown as Record<string, unknown>;
let networkRequestSeq = 0;

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
  const consoleMethods = [
    "log",
    "info",
    "warn",
    "error",
    "debug",
    "assert",
    "trace",
    "dir",
    "dirxml",
    "table",
    "group",
    "groupCollapsed",
    "groupEnd",
    "count",
    "countReset",
    "time",
    "timeEnd",
    "timeLog",
    "clear"
  ] as const;
  const consoleRecord = console as unknown as Record<string, (...args: unknown[]) => unknown>;

  for (const method of consoleMethods) {
    const original = consoleRecord[method];

    if (typeof original !== "function") {
      continue;
    }

    consoleRecord[method] = (...args: unknown[]) => {
      if (method === "assert" && Boolean(args[0])) {
        return Reflect.apply(original, console, args);
      }

      const level = consoleMethodToLevel(method);
      const serializedArgs = args.map((value) => safeSerialize(value));

      emit("console", {
        source: "injected",
        method,
        level,
        args: serializedArgs,
        text: formatConsoleText(serializedArgs),
        stackTop: readStackTop()
      });

      return Reflect.apply(original, console, args);
    };
  }
}

function consoleMethodToLevel(method: string): "log" | "info" | "warn" | "error" | "debug" {
  if (method === "error" || method === "assert") {
    return "error";
  }

  if (method === "warn") {
    return "warn";
  }

  if (method === "info") {
    return "info";
  }

  if (method === "debug" || method === "trace") {
    return "debug";
  }

  return "log";
}

function formatConsoleText(args: unknown[]): string {
  if (args.length === 0) {
    return "";
  }

  const parts = args
    .slice(0, 8)
    .map((entry) => stringifyValue(entry))
    .filter((entry) => entry.length > 0);

  const joined = parts.join(" ");
  return joined.length > 600 ? `${joined.slice(0, 597)}...` : joined;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }

  if (value === undefined) {
    return "undefined";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readStackTop(): string | undefined {
  const stack = new Error().stack;

  if (!stack) {
    return undefined;
  }

  const lines = stack.split("\n").map((line) => line.trim());
  const selfLine = lines.findIndex((line) => line.includes("installConsoleHooks"));
  const candidate =
    selfLine >= 0 ? (lines[selfLine + 2] ?? lines[selfLine + 1]) : (lines[2] ?? lines[1]);

  return candidate ? candidate.slice(0, 260) : undefined;
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
    const requestMeta = resolveFetchRequestMeta(args);
    const reqId = nextRequestId("fetch");
    const startedMono = monotonicTime();

    emit("fetch", {
      phase: "start",
      reqId,
      requestId: reqId,
      method: requestMeta.method,
      url: requestMeta.url,
      headers: requestMeta.headers,
      postDataSize: requestMeta.postDataSize
    });

    try {
      const response = await originalFetch(...args);
      const contentType = normalizeContentType(response.headers.get("content-type"));
      const encodedDataLength = parseHeaderInt(response.headers.get("content-length"));

      emit("fetch", {
        phase: "end",
        reqId,
        requestId: reqId,
        method: requestMeta.method,
        url: requestMeta.url,
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        redirected: response.redirected,
        responseUrl: response.url,
        mimeType: contentType,
        headers: readHeaders(response.headers),
        encodedDataLength,
        duration: monotonicTime() - startedMono
      });

      return response;
    } catch (error) {
      emit("fetchError", {
        reqId,
        requestId: reqId,
        method: requestMeta.method,
        url: requestMeta.url,
        duration: monotonicTime() - startedMono,
        message: error instanceof Error ? error.message : String(error),
        errorText: error instanceof Error ? error.message : String(error)
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
      this as XMLHttpRequest & {
        __wbReqId?: string;
        __wbMethod?: string;
        __wbUrl?: string;
        __wbStartedMono?: number;
        __wbFailed?: boolean;
      }
    ).__wbReqId = nextRequestId("xhr");
    (
      this as XMLHttpRequest & {
        __wbReqId?: string;
        __wbMethod?: string;
        __wbUrl?: string;
        __wbStartedMono?: number;
        __wbFailed?: boolean;
      }
    ).__wbMethod = method;
    (
      this as XMLHttpRequest & {
        __wbReqId?: string;
        __wbMethod?: string;
        __wbUrl?: string;
        __wbStartedMono?: number;
        __wbFailed?: boolean;
      }
    ).__wbUrl = typeof url === "string" ? url : url.toString();
    (
      this as XMLHttpRequest & {
        __wbReqId?: string;
        __wbMethod?: string;
        __wbUrl?: string;
        __wbStartedMono?: number;
        __wbFailed?: boolean;
      }
    ).__wbFailed = false;

    xhrOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
    const xhr = this as XMLHttpRequest & {
      __wbReqId?: string;
      __wbMethod?: string;
      __wbUrl?: string;
      __wbStartedMono?: number;
      __wbFailed?: boolean;
    };
    xhr.__wbStartedMono = monotonicTime();
    const reqId = xhr.__wbReqId ?? nextRequestId("xhr");
    xhr.__wbReqId = reqId;

    emit("xhr", {
      phase: "start",
      reqId,
      requestId: reqId,
      method: xhr.__wbMethod ?? "GET",
      url: xhr.__wbUrl ?? "unknown",
      postDataSize: estimateBodyLength(body)
    });

    const emitXhrFailure = (reason: string) => {
      if (xhr.__wbFailed) {
        return;
      }

      xhr.__wbFailed = true;

      emit("fetchError", {
        reqId,
        requestId: reqId,
        method: xhr.__wbMethod ?? "GET",
        url: xhr.__wbUrl ?? "unknown",
        duration: monotonicTime() - (xhr.__wbStartedMono ?? monotonicTime()),
        message: reason,
        errorText: reason
      });
    };

    this.addEventListener(
      "error",
      () => {
        emitXhrFailure("XHR error");
      },
      { once: true }
    );
    this.addEventListener(
      "abort",
      () => {
        emitXhrFailure("XHR aborted");
      },
      { once: true }
    );
    this.addEventListener(
      "timeout",
      () => {
        emitXhrFailure("XHR timeout");
      },
      { once: true }
    );

    this.addEventListener("loadend", () => {
      const contentType = normalizeContentType(this.getResponseHeader("content-type"));

      emit("xhr", {
        phase: "end",
        reqId,
        requestId: reqId,
        method: xhr.__wbMethod ?? "GET",
        url: this.responseURL || xhr.__wbUrl || "unknown",
        status: this.status,
        statusText: this.statusText,
        ok: this.status >= 200 && this.status < 400,
        headers: parseXhrResponseHeaders(this.getAllResponseHeaders()),
        mimeType: contentType,
        encodedDataLength: parseHeaderInt(this.getResponseHeader("content-length")),
        failed: Boolean(xhr.__wbFailed),
        duration: monotonicTime() - (xhr.__wbStartedMono ?? monotonicTime())
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
        const streamId = nextRequestId("sse");

        emit("sse", {
          phase: "open",
          url,
          streamId,
          requestId: streamId
        });

        this.addEventListener("message", (event) => {
          emit("sse", {
            phase: "message",
            url,
            streamId,
            requestId: streamId,
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
            streamId,
            requestId: streamId,
            readyState: this.readyState
          });
        });
      }
    }

    window.EventSource = WebBlackboxEventSource as typeof EventSource;
    windowFlags.__WEBBLACKBOX_EVENTSOURCE_PATCHED__ = true;
  }
}

function nextRequestId(prefix: "fetch" | "xhr" | "sse"): string {
  networkRequestSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${networkRequestSeq.toString(36)}`;
}

function resolveFetchRequestMeta(args: Parameters<typeof fetch>): {
  url: string;
  method: string;
  headers?: Record<string, string>;
  postDataSize?: number;
} {
  const [request, init] = args;
  const requestInit = init ?? {};
  const requestUrl =
    request instanceof Request
      ? request.url
      : typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : "unknown";
  const requestMethod = (
    requestInit.method ??
    (request instanceof Request ? request.method : undefined) ??
    "GET"
  ).toUpperCase();
  const headerSource =
    requestInit.headers ?? (request instanceof Request ? request.headers : undefined);
  const headers = headerSource ? toHeaderRecord(headerSource) : undefined;
  const bodyCandidate = requestInit.body;
  const postDataSize = estimateBodyLength(bodyCandidate);

  return {
    url: requestUrl,
    method: requestMethod,
    headers,
    postDataSize
  };
}

function toHeaderRecord(rawHeaders: HeadersInit): Record<string, string> | undefined {
  const headers = new Headers(rawHeaders);
  const output: Record<string, string> = {};
  let count = 0;

  headers.forEach((value, key) => {
    if (count >= 64) {
      return;
    }

    output[key] = value.slice(0, 500);
    count += 1;
  });

  return count > 0 ? output : undefined;
}

function readHeaders(headers: Headers): Record<string, string> | undefined {
  return toHeaderRecord(headers);
}

function parseXhrResponseHeaders(value: string): Record<string, string> | undefined {
  if (value.trim().length === 0) {
    return undefined;
  }

  const output: Record<string, string> = {};
  let count = 0;

  for (const line of value.split(/\r?\n/)) {
    if (count >= 64 || line.trim().length === 0) {
      continue;
    }

    const separatorIndex = line.indexOf(":");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const entry = line.slice(separatorIndex + 1).trim();

    if (key.length === 0 || entry.length === 0) {
      continue;
    }

    output[key] = entry.slice(0, 500);
    count += 1;
  }

  return count > 0 ? output : undefined;
}

function parseHeaderInt(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeContentType(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  const [mime] = value.split(";");
  const normalized = mime?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function estimateBodyLength(value: unknown): number | undefined {
  if (typeof value === "string") {
    return value.length;
  }

  if (value instanceof URLSearchParams) {
    return value.toString().length;
  }

  if (value instanceof FormData) {
    let total = 0;

    for (const [key, entry] of value.entries()) {
      total += key.length;

      if (typeof entry === "string") {
        total += entry.length;
      } else if (entry instanceof Blob) {
        total += entry.size;
      }
    }

    return total;
  }

  if (value instanceof Blob) {
    return value.size;
  }

  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }

  if (ArrayBuffer.isView(value)) {
    return value.byteLength;
  }

  return undefined;
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
