/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INJECTED_CAPTURE_CONFIG_EVENT,
  INJECTED_MESSAGE_SOURCE,
  type InjectedCaptureConfig,
  type InjectedCaptureWindowMessage,
  installInjectedLiteCaptureHooks
} from "./injected-hooks.js";

type CaptureEventMessage = {
  rawType: string;
  payload: Record<string, unknown>;
  t: number;
  mono: number;
};

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

      if (row?.source !== INJECTED_MESSAGE_SOURCE) {
        return;
      }

      if (row.kind === "capture-event") {
        captured.push({
          rawType: row.rawType,
          payload: row.payload,
          t: row.t,
          mono: row.mono
        });
        return;
      }

      if (row.kind === "capture-events" && Array.isArray(row.events)) {
        captured.push(...row.events);
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.fetch = originalFetch;
    localStorage.clear();
    sessionStorage.clear();
  });

  it("is idempotent for the same flag and emits ready + console events", async () => {
    const flag = "__WB_TEST_INJECTED_CONSOLE__";

    installInjectedLiteCaptureHooks({ flag });
    installInjectedLiteCaptureHooks({ flag });
    await delay(10);

    const notices = captured.filter(
      (message) =>
        message.rawType === "notice" &&
        (message.payload as { message?: unknown }).message === "injected-ready"
    );

    expect(notices).toHaveLength(1);

    const markerText = `wb-console-${Date.now()}`;
    console.info(markerText, { ok: true });
    await delay(10);

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

    installInjectedLiteCaptureHooks({
      flag,
      bodyCaptureMaxBytes: 128 * 1024
    });

    await window.fetch("https://example.test/api/demo/123?token=secret#frag", {
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
      url: "https://example.test/api/demo/:id"
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

  it("skips response-body sampling until capture config enables it", async () => {
    const flag = "__WB_TEST_INJECTED_FETCH_CONFIG__";

    window.fetch = vi.fn(async () => {
      return new Response('{"ok":true,"token":"abc"}', {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    }) as typeof fetch;

    installInjectedLiteCaptureHooks({ flag });

    await window.fetch("https://example.test/api/disabled");
    await delay(20);

    expect(captured.some((message) => message.rawType === "networkBody")).toBe(false);

    window.dispatchEvent(
      new CustomEvent<InjectedCaptureConfig>(INJECTED_CAPTURE_CONFIG_EVENT, {
        detail: {
          bodyCaptureMaxBytes: 64 * 1024
        }
      })
    );

    await window.fetch("https://example.test/api/enabled");

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (captured.some((message) => message.rawType === "networkBody")) {
        break;
      }

      await delay(5);
    }

    const networkBody = captured.find((message) => message.rawType === "networkBody");
    expect(networkBody?.payload).toMatchObject({
      source: "fetch",
      url: "https://example.test/api/enabled"
    });
  });

  it("suppresses hook emissions while runtime capture is inactive", async () => {
    const flag = "__WB_TEST_INJECTED_ACTIVE_GATE__";

    installInjectedLiteCaptureHooks({ flag, active: false });
    await delay(10);

    expect(captured).toHaveLength(0);

    console.info("inactive-console");
    await delay(10);

    expect(captured.some((message) => message.rawType === "console")).toBe(false);

    window.dispatchEvent(
      new CustomEvent<InjectedCaptureConfig>(INJECTED_CAPTURE_CONFIG_EVENT, {
        detail: {
          active: true
        }
      })
    );

    console.info("active-console");
    await delay(10);

    expect(captured.some((message) => message.rawType === "console")).toBe(true);

    captured.length = 0;
    window.dispatchEvent(
      new CustomEvent<InjectedCaptureConfig>(INJECTED_CAPTURE_CONFIG_EVENT, {
        detail: {
          active: false
        }
      })
    );

    console.info("inactive-again");
    await delay(10);

    expect(captured.some((message) => message.rawType === "console")).toBe(false);
  });

  it("does not patch page-side network hooks when captureNetwork is disabled", async () => {
    const flag = "__WB_TEST_INJECTED_NETWORK_DISABLED__";
    window.fetch = vi.fn(async () => new Response("ok")) as typeof fetch;
    const originalFetchRef = window.fetch;
    const openSpy = vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(() => undefined);
    const sendSpy = vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => undefined);

    installInjectedLiteCaptureHooks({
      flag,
      captureNetwork: false
    });

    expect(window.fetch).toBe(originalFetchRef);

    await fetch("https://example.test/disabled-network");
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "/disabled-network-xhr");
    xhr.send();
    await delay(10);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(captured.some((message) => message.rawType === "fetch")).toBe(false);
    expect(captured.some((message) => message.rawType === "xhr")).toBe(false);
  });

  it("serializes invalid Date values without throwing", async () => {
    const flag = "__WB_TEST_INJECTED_INVALID_DATE__";
    installInjectedLiteCaptureHooks({ flag });

    expect(() => {
      console.log(new Date("this-is-not-a-date"));
    }).not.toThrow();
    await delay(10);

    const consoleEvent = captured.filter((message) => message.rawType === "console").at(-1);
    const payload = (consoleEvent?.payload ?? {}) as {
      args?: unknown[];
      text?: unknown;
    };

    expect(payload.args?.[0]).toBe("Invalid Date");
    expect(String(payload.text ?? "")).toContain("Invalid Date");
  });

  it("handles objects with throwing getters without breaking console", async () => {
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
    await delay(10);

    const consoleEvent = captured.filter((message) => message.rawType === "console").at(-1);
    const payload = (consoleEvent?.payload ?? {}) as {
      args?: unknown[];
    };

    expect(payload.args?.[0]).toEqual({ boom: "[Unreadable]" });
  });

  it("does not duplicate xhr end events when reusing the same xhr instance", async () => {
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
    await delay(10);

    const endEvents = captured.filter(
      (message) =>
        message.rawType === "xhr" && (message.payload as { phase?: unknown }).phase === "end"
    );

    expect(endEvents).toHaveLength(2);
  });

  it("preserves xhr open argument shape without forcing null credentials", async () => {
    const openSpy = vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(() => undefined);
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => undefined);

    const flag = "__WB_TEST_INJECTED_XHR_OPEN_ARGS__";
    installInjectedLiteCaptureHooks({ flag });

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://example.test/no-auth");
    xhr.open("GET", "https://example.test/with-auth", true, "demo-user", "demo-pass");
    await delay(10);

    const firstCall = openSpy.mock.calls[0];
    const secondCall = openSpy.mock.calls[1];

    expect(firstCall).toEqual(["GET", "https://example.test/no-auth"]);
    expect(secondCall).toEqual([
      "GET",
      "https://example.test/with-auth",
      true,
      "demo-user",
      "demo-pass"
    ]);
  });
});
