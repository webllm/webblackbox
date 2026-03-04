type CapturePayload = Record<string, unknown>;

const DEFAULT_FLAG = "__WEBBLACKBOX_INJECTED__";
const NETWORK_BODY_CAPTURE_MAX_BYTES = 128 * 1024;
const NETWORK_BODY_CAPTURE_MAX_PER_MINUTE = 45;
const NETWORK_BODY_CAPTURE_MAX_BYTES_PER_MINUTE = 4 * 1024 * 1024;
const NOISY_CONSOLE_MAX_PER_SEC = 40;
const NOISY_CONSOLE_METHODS = new Set(["log", "info", "debug", "dir", "dirxml", "table"]);
const SAFE_SERIALIZE_MAX_DEPTH = 3;
const SAFE_SERIALIZE_MAX_PROPERTIES = 24;
const SAFE_SERIALIZE_MAX_STRING_CHARS = 1_200;

/** `window.postMessage` source tag used by injected lite capture hooks. */
export const INJECTED_MESSAGE_SOURCE = "webblackbox-injected";

/** Message contract emitted by injected hooks into the page window. */
export type InjectedCaptureWindowMessage =
  | {
      source: typeof INJECTED_MESSAGE_SOURCE;
      kind: "capture-event";
      rawType: string;
      payload: CapturePayload;
      t: number;
      mono: number;
    }
  | {
      source: typeof INJECTED_MESSAGE_SOURCE;
      kind: "marker";
      message?: string;
      t: number;
      mono: number;
    };

/** Options for installing browser-side injected hooks. */
export type InjectedHooksOptions = {
  /** Global flag name used to prevent duplicate hook installation. */
  flag?: string;
};

/**
 * Installs lightweight console/error/network/storage hooks into the current page.
 * Hooks emit capture events via `window.postMessage`.
 */
export function installInjectedLiteCaptureHooks(options: InjectedHooksOptions = {}): void {
  if (typeof window === "undefined") {
    return;
  }

  const flag = options.flag ?? DEFAULT_FLAG;
  const windowFlags = window as unknown as Record<string, unknown>;
  let networkRequestSeq = 0;
  let bodyWindowStartedAt = Date.now();
  let bodyWindowCount = 0;
  let bodyWindowBytes = 0;

  if (windowFlags[flag]) {
    return;
  }

  windowFlags[flag] = true;
  installConsoleHooks();
  installErrorHooks();
  installStorageHooks();
  installNetworkHooks();
  installIndexedDbHooks();

  emit("notice", {
    message: "injected-ready",
    href: location.href
  });

  function emit(rawType: string, payload: CapturePayload): void {
    const message: InjectedCaptureWindowMessage = {
      source: INJECTED_MESSAGE_SOURCE,
      kind: "capture-event",
      rawType,
      payload,
      t: Date.now(),
      mono: monotonicTime()
    };

    window.postMessage(message, "*");
  }

  function monotonicTime(): number {
    return performance.timeOrigin + performance.now();
  }

  function allowBodyCapture(sampledBytes: number): boolean {
    const now = Date.now();

    if (now - bodyWindowStartedAt >= 60_000) {
      bodyWindowStartedAt = now;
      bodyWindowCount = 0;
      bodyWindowBytes = 0;
    }

    if (bodyWindowCount >= NETWORK_BODY_CAPTURE_MAX_PER_MINUTE) {
      return false;
    }

    if (bodyWindowBytes + sampledBytes > NETWORK_BODY_CAPTURE_MAX_BYTES_PER_MINUTE) {
      return false;
    }

    bodyWindowCount += 1;
    bodyWindowBytes += sampledBytes;
    return true;
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
    let noisyWindowStartedAt = Date.now();
    let noisyWindowCount = 0;

    for (const method of consoleMethods) {
      const original = consoleRecord[method];

      if (typeof original !== "function") {
        continue;
      }

      consoleRecord[method] = (...args: unknown[]) => {
        if (method === "assert" && Boolean(args[0])) {
          return Reflect.apply(original, console, args);
        }

        const now = Date.now();

        if (now - noisyWindowStartedAt >= 1_000) {
          noisyWindowStartedAt = now;
          noisyWindowCount = 0;
        }

        if (NOISY_CONSOLE_METHODS.has(method)) {
          noisyWindowCount += 1;

          if (noisyWindowCount > NOISY_CONSOLE_MAX_PER_SEC) {
            return Reflect.apply(original, console, args);
          }
        }

        const level = consoleMethodToLevel(method);
        const serializedArgs = args.slice(0, 10).map((value) => safeSerialize(value));
        const includeStack =
          method === "error" || method === "warn" || method === "assert" || method === "trace";

        emit("console", {
          source: "injected",
          method,
          level,
          args: serializedArgs,
          text: formatConsoleText(serializedArgs),
          stackTop: includeStack ? readStackTop() : undefined
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

        void emitFetchResponseBody(reqId, requestMeta, response);

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

    XMLHttpRequest.prototype.send = function (
      body?: Document | XMLHttpRequestBodyInit | null
    ): void {
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

      this.addEventListener(
        "loadend",
        () => {
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

          void emitXhrResponseBody(reqId, xhr, contentType);
        },
        { once: true }
      );

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
                typeof event.data === "string"
                  ? event.data.slice(0, 800)
                  : safeSerialize(event.data)
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

  async function emitFetchResponseBody(
    reqId: string,
    requestMeta: {
      method: string;
      url: string;
    },
    response: Response
  ): Promise<void> {
    if (response.type === "opaque" || response.type === "opaqueredirect") {
      return;
    }

    const contentType = normalizeContentType(response.headers.get("content-type"));

    if (!isBodyCaptureMimeAllowed(contentType)) {
      return;
    }

    const encodedDataLength = parseHeaderInt(response.headers.get("content-length"));

    if (
      typeof encodedDataLength === "number" &&
      encodedDataLength > NETWORK_BODY_CAPTURE_MAX_BYTES
    ) {
      return;
    }

    const sampled = await readFetchBodySample(response, NETWORK_BODY_CAPTURE_MAX_BYTES);

    if (!sampled || sampled.body.length === 0) {
      return;
    }

    if (!allowBodyCapture(sampled.sampledBytes)) {
      return;
    }

    emit("networkBody", {
      source: "fetch",
      reqId,
      requestId: reqId,
      method: requestMeta.method,
      url: response.url || requestMeta.url,
      status: response.status,
      mimeType: contentType,
      encoding: "utf8",
      body: sampled.body,
      size:
        typeof encodedDataLength === "number"
          ? encodedDataLength
          : sampled.truncated
            ? Math.max(sampled.sampledBytes + 1, sampled.sampledBytes)
            : sampled.sampledBytes,
      sampledSize: sampled.sampledBytes,
      truncated:
        sampled.truncated ||
        (typeof encodedDataLength === "number" && encodedDataLength > sampled.sampledBytes)
    });
  }

  async function emitXhrResponseBody(
    reqId: string,
    xhr: XMLHttpRequest & {
      __wbMethod?: string;
      __wbUrl?: string;
    },
    contentType: string | undefined
  ): Promise<void> {
    if (!isBodyCaptureMimeAllowed(contentType)) {
      return;
    }

    const encodedDataLength = parseHeaderInt(xhr.getResponseHeader("content-length"));

    if (
      typeof encodedDataLength === "number" &&
      encodedDataLength > NETWORK_BODY_CAPTURE_MAX_BYTES
    ) {
      return;
    }

    const bodyText = await readXhrBodyText(xhr);

    if (!bodyText || bodyText.length === 0) {
      return;
    }

    const clipped = clipUtf8Text(bodyText, NETWORK_BODY_CAPTURE_MAX_BYTES);
    const sampledSize = new TextEncoder().encode(clipped.value).byteLength;

    if (!allowBodyCapture(sampledSize)) {
      return;
    }

    emit("networkBody", {
      source: "xhr",
      reqId,
      requestId: reqId,
      method: xhr.__wbMethod ?? "GET",
      url: xhr.responseURL || xhr.__wbUrl || "unknown",
      status: xhr.status,
      statusText: xhr.statusText,
      mimeType: contentType,
      encoding: "utf8",
      body: clipped.value,
      size: typeof encodedDataLength === "number" ? encodedDataLength : clipped.fullBytes,
      sampledSize,
      truncated:
        clipped.truncated ||
        (typeof encodedDataLength === "number" && encodedDataLength > sampledSize)
    });
  }

  async function readFetchBodySample(
    response: Response,
    maxBytes: number
  ): Promise<{ body: string; sampledBytes: number; truncated: boolean } | null> {
    const cloned = response.clone();

    if (!cloned.body || typeof cloned.body.getReader !== "function") {
      try {
        const bodyText = await cloned.text();
        const clipped = clipUtf8Text(bodyText, maxBytes);
        const sampledBytes = new TextEncoder().encode(clipped.value).byteLength;
        return {
          body: clipped.value,
          sampledBytes,
          truncated: clipped.truncated
        };
      } catch {
        return null;
      }
    }

    const reader = cloned.body.getReader();
    const chunks: Uint8Array[] = [];
    let sampledBytes = 0;
    let truncated = false;

    try {
      while (sampledBytes < maxBytes) {
        const result = await reader.read();

        if (result.done) {
          break;
        }

        const value = toUint8Array(result.value);

        if (!value || value.byteLength === 0) {
          continue;
        }

        const remaining = maxBytes - sampledBytes;

        if (value.byteLength <= remaining) {
          chunks.push(value);
          sampledBytes += value.byteLength;
          continue;
        }

        chunks.push(value.slice(0, remaining));
        sampledBytes += remaining;
        truncated = true;
        break;
      }
    } catch {
      return null;
    } finally {
      try {
        await reader.cancel();
      } catch {
        void 0;
      }
    }

    if (chunks.length === 0) {
      return null;
    }

    const decoder = new TextDecoder();
    let body = "";

    for (const chunk of chunks) {
      body += decoder.decode(chunk, {
        stream: true
      });
    }

    body += decoder.decode();

    return {
      body,
      sampledBytes,
      truncated
    };
  }

  function toUint8Array(value: unknown): Uint8Array | null {
    if (value instanceof Uint8Array) {
      return value;
    }

    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }

    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }

    if (typeof value === "string") {
      return new TextEncoder().encode(value);
    }

    return null;
  }

  async function readXhrBodyText(xhr: XMLHttpRequest): Promise<string | null> {
    const responseType = xhr.responseType;

    if (responseType === "" || responseType === "text") {
      return typeof xhr.responseText === "string" ? xhr.responseText : null;
    }

    if (responseType === "json") {
      if (xhr.response === null || xhr.response === undefined) {
        return null;
      }

      try {
        return JSON.stringify(xhr.response);
      } catch {
        return null;
      }
    }

    if (responseType === "document") {
      const responseDocument = xhr.responseXML;
      return responseDocument?.documentElement?.outerHTML ?? null;
    }

    if (responseType === "arraybuffer" && xhr.response instanceof ArrayBuffer) {
      try {
        return new TextDecoder().decode(new Uint8Array(xhr.response));
      } catch {
        return null;
      }
    }

    if (responseType === "blob" && xhr.response instanceof Blob) {
      try {
        return await xhr.response.text();
      } catch {
        return null;
      }
    }

    return null;
  }

  function clipUtf8Text(
    value: string,
    maxBytes: number
  ): { value: string; fullBytes: number; truncated: boolean } {
    const encoder = new TextEncoder();
    const fullBytes = encoder.encode(value);

    if (fullBytes.byteLength <= maxBytes) {
      return {
        value,
        fullBytes: fullBytes.byteLength,
        truncated: false
      };
    }

    const roughRatio = Math.max(0.05, maxBytes / fullBytes.byteLength);
    let targetChars = Math.max(1, Math.floor(value.length * roughRatio));
    let clipped = value.slice(0, targetChars);
    let clippedBytes = encoder.encode(clipped);

    while (clippedBytes.byteLength > maxBytes && targetChars > 1) {
      targetChars = Math.max(1, Math.floor(targetChars * 0.9));
      clipped = value.slice(0, targetChars);
      clippedBytes = encoder.encode(clipped);
    }

    return {
      value: clipped,
      fullBytes: fullBytes.byteLength,
      truncated: true
    };
  }

  function isBodyCaptureMimeAllowed(mimeType: string | undefined): boolean {
    if (!mimeType) {
      return true;
    }

    const normalized = mimeType.toLowerCase();

    return (
      normalized.startsWith("text/") ||
      normalized.includes("json") ||
      normalized.includes("xml") ||
      normalized.includes("javascript") ||
      normalized.includes("x-www-form-urlencoded")
    );
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

      if (!key) {
        continue;
      }

      output[key] = entry.slice(0, 500);
      count += 1;
    }

    return Object.keys(output).length > 0 ? output : undefined;
  }

  function parseHeaderInt(value: string | null): number | undefined {
    if (!value) {
      return undefined;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  function normalizeContentType(value: string | null): string | undefined {
    if (!value) {
      return undefined;
    }

    const [mime] = value.split(";");
    const normalized = mime?.trim().toLowerCase();
    return normalized && normalized.length > 0 ? normalized : undefined;
  }

  function estimateBodyLength(body: unknown): number | undefined {
    if (typeof body === "string") {
      return new TextEncoder().encode(body).byteLength;
    }

    if (body instanceof URLSearchParams) {
      return new TextEncoder().encode(body.toString()).byteLength;
    }

    if (body instanceof Blob) {
      return body.size;
    }

    if (body instanceof ArrayBuffer) {
      return body.byteLength;
    }

    if (ArrayBuffer.isView(body)) {
      return body.byteLength;
    }

    if (body instanceof FormData) {
      let length = 0;

      for (const [, entry] of body.entries()) {
        if (typeof entry === "string") {
          length += new TextEncoder().encode(entry).byteLength;
          continue;
        }

        length += entry.size;
      }

      return length;
    }

    return undefined;
  }

  function installIndexedDbHooks(): void {
    if (!("indexedDB" in window) || typeof indexedDB.open !== "function") {
      return;
    }

    const open = indexedDB.open.bind(indexedDB);

    indexedDB.open = (name: string, version?: number) => {
      emit("indexedDbOp", {
        op: "open",
        name,
        version
      });

      return open(name, version);
    };
  }

  function readTargetUrl(target: HTMLElement): string | undefined {
    if (target instanceof HTMLScriptElement || target instanceof HTMLImageElement) {
      return target.src || undefined;
    }

    if (target instanceof HTMLLinkElement) {
      return target.href || undefined;
    }

    return undefined;
  }

  function safeSerialize(value: unknown, depth = 0): unknown {
    if (depth >= SAFE_SERIALIZE_MAX_DEPTH) {
      return summarizeValue(value);
    }

    if (
      value === null ||
      value === undefined ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }

    if (typeof value === "string") {
      return compactString(value, SAFE_SERIALIZE_MAX_STRING_CHARS);
    }

    if (typeof value === "bigint") {
      return value.toString();
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack
      };
    }

    if (typeof value === "function") {
      return `[Function ${value.name || "anonymous"}]`;
    }

    if (value instanceof HTMLElement) {
      return {
        tag: value.tagName,
        id: value.id || undefined,
        className: value.className || undefined,
        text: value.textContent?.trim().slice(0, 120)
      };
    }

    if (Array.isArray(value)) {
      return value.slice(0, 20).map((entry) => safeSerialize(entry, depth + 1));
    }

    if (value instanceof Map) {
      return {
        map: [...value.entries()]
          .slice(0, 20)
          .map(([key, entry]) => [safeSerialize(key, depth + 1), safeSerialize(entry, depth + 1)])
      };
    }

    if (value instanceof Set) {
      return {
        set: [...value.values()].slice(0, 20).map((entry) => safeSerialize(entry, depth + 1))
      };
    }

    if (value instanceof URL) {
      return value.toString();
    }

    if (value instanceof Date) {
      return serializeDate(value);
    }

    if (value instanceof ArrayBuffer) {
      return {
        type: "ArrayBuffer",
        byteLength: value.byteLength
      };
    }

    if (ArrayBuffer.isView(value)) {
      return {
        type: value.constructor.name,
        byteLength: value.byteLength
      };
    }

    if (typeof value === "object") {
      const output: Record<string, unknown> = {};
      let count = 0;
      let keys: string[];

      try {
        keys = Object.keys(value as Record<string, unknown>);
      } catch {
        return summarizeValue(value);
      }

      for (const key of keys) {
        if (count >= SAFE_SERIALIZE_MAX_PROPERTIES) {
          output.__truncated = true;
          break;
        }

        try {
          output[key] = safeSerialize((value as Record<string, unknown>)[key], depth + 1);
        } catch {
          output[key] = "[Unreadable]";
        }

        count += 1;
      }

      return output;
    }

    return String(value);
  }

  function summarizeValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return `[Array(${value.length})]`;
    }

    if (value instanceof Map) {
      return `[Map(${value.size})]`;
    }

    if (value instanceof Set) {
      return `[Set(${value.size})]`;
    }

    if (value instanceof Date) {
      return serializeDate(value);
    }

    if (value instanceof URL) {
      return value.toString();
    }

    if (value && typeof value === "object") {
      return `[${value.constructor?.name || "Object"}]`;
    }

    return String(value);
  }

  function compactString(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }

    return `${value.slice(0, maxLength - 3)}...`;
  }

  function serializeDate(value: Date): string {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
}
