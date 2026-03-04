/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INJECTED_MESSAGE_SOURCE,
  type InjectedCaptureWindowMessage,
  installInjectedLiteCaptureHooks
} from "./injected-hooks.js";

type CaptureEventMessage = Extract<InjectedCaptureWindowMessage, { kind: "capture-event" }>;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("injected-hooks", () => {
  const originalFetch = window.fetch;
  const captured: CaptureEventMessage[] = [];

  beforeEach(() => {
    captured.length = 0;
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
      const row = message as InjectedCaptureWindowMessage;

      if (row?.source === INJECTED_MESSAGE_SOURCE && row.kind === "capture-event") {
        captured.push(row);
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.fetch = originalFetch;
    localStorage.clear();
    sessionStorage.clear();
  });

  it("is idempotent for the same flag and emits ready + console events", () => {
    const flag = "__WB_TEST_INJECTED_CONSOLE__";

    installInjectedLiteCaptureHooks({ flag });
    installInjectedLiteCaptureHooks({ flag });

    const notices = captured.filter(
      (message) =>
        message.rawType === "notice" &&
        (message.payload as { message?: unknown }).message === "injected-ready"
    );

    expect(notices).toHaveLength(1);

    const markerText = `wb-console-${Date.now()}`;
    console.info(markerText, { ok: true });

    const consoleEvents = captured.filter((message) => message.rawType === "console");
    expect(consoleEvents.length).toBeGreaterThan(0);

    const event = consoleEvents.at(-1);
    expect(event?.payload).toMatchObject({
      source: "injected",
      method: "info",
      level: "info"
    });
    expect(String((event?.payload as { text?: unknown }).text ?? "")).toContain(markerText);
  });

  it("captures fetch start/end and sampled response body", async () => {
    const flag = "__WB_TEST_INJECTED_FETCH__";

    window.fetch = vi.fn(async () => {
      return new Response('{"ok":true,"token":"abc"}', {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    }) as typeof fetch;

    installInjectedLiteCaptureHooks({ flag });

    await window.fetch("https://example.test/api/demo", {
      method: "POST",
      body: '{"token":"abc"}'
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const hasBody = captured.some((message) => message.rawType === "networkBody");

      if (hasBody) {
        break;
      }

      await delay(5);
    }

    const fetchStart = captured.find(
      (message) =>
        message.rawType === "fetch" && (message.payload as { phase?: unknown }).phase === "start"
    );

    const fetchEnd = captured.find(
      (message) =>
        message.rawType === "fetch" && (message.payload as { phase?: unknown }).phase === "end"
    );

    const networkBody = captured.find((message) => message.rawType === "networkBody");

    expect(fetchStart?.payload).toMatchObject({
      method: "POST",
      url: "https://example.test/api/demo"
    });
    expect(fetchEnd?.payload).toMatchObject({
      status: 200,
      ok: true
    });
    expect(networkBody?.payload).toMatchObject({
      source: "fetch",
      method: "POST",
      status: 200,
      mimeType: "application/json",
      encoding: "utf8"
    });
    expect(String((networkBody?.payload as { body?: unknown }).body ?? "")).toContain('"ok":true');
  });

  it("serializes invalid Date values without throwing", () => {
    const flag = "__WB_TEST_INJECTED_INVALID_DATE__";
    installInjectedLiteCaptureHooks({ flag });

    expect(() => {
      console.log(new Date("this-is-not-a-date"));
    }).not.toThrow();

    const consoleEvent = captured.filter((message) => message.rawType === "console").at(-1);
    const payload = (consoleEvent?.payload ?? {}) as {
      args?: unknown[];
      text?: unknown;
    };

    expect(payload.args?.[0]).toBe("Invalid Date");
    expect(String(payload.text ?? "")).toContain("Invalid Date");
  });

  it("handles objects with throwing getters without breaking console", () => {
    const flag = "__WB_TEST_INJECTED_THROWING_GETTER__";
    installInjectedLiteCaptureHooks({ flag });

    const value: Record<string, unknown> = {};
    Object.defineProperty(value, "boom", {
      enumerable: true,
      get: () => {
        throw new Error("boom");
      }
    });

    expect(() => {
      console.log(value);
    }).not.toThrow();

    const consoleEvent = captured.filter((message) => message.rawType === "console").at(-1);
    const payload = (consoleEvent?.payload ?? {}) as {
      args?: unknown[];
    };

    expect(payload.args?.[0]).toEqual({ boom: "[Unreadable]" });
  });

  it("does not duplicate xhr end events when reusing the same xhr instance", () => {
    vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(() => undefined);
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => undefined);
    vi.spyOn(XMLHttpRequest.prototype, "getResponseHeader").mockImplementation(() => null);
    vi.spyOn(XMLHttpRequest.prototype, "getAllResponseHeaders").mockImplementation(() => "");

    const flag = "__WB_TEST_INJECTED_XHR_REUSE__";
    installInjectedLiteCaptureHooks({ flag });

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://example.test/first");
    xhr.send();
    xhr.dispatchEvent(new Event("loadend"));

    xhr.open("GET", "https://example.test/second");
    xhr.send();
    xhr.dispatchEvent(new Event("loadend"));

    const endEvents = captured.filter(
      (message) =>
        message.rawType === "xhr" && (message.payload as { phase?: unknown }).phase === "end"
    );

    expect(endEvents).toHaveLength(2);
  });
});
