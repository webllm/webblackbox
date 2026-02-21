import { describe, expect, it } from "vitest";

import type { RecorderConfig } from "@webblackbox/protocol";

import { EventRingBuffer } from "./ring-buffer.js";
import { createDefaultRecorderPlugins } from "./plugins.js";
import { WebBlackboxRecorder } from "./recorder.js";
import { redactPayload } from "./redaction.js";

const TEST_CONFIG: RecorderConfig = {
  mode: "lite",
  ringBufferMinutes: 10,
  freezeOnError: true,
  freezeOnNetworkFailure: true,
  freezeOnLongTaskSpike: true,
  sampling: {
    mousemoveHz: 20,
    scrollHz: 15,
    domFlushMs: 100,
    screenshotIdleMs: 8000,
    snapshotIntervalMs: 20000,
    actionWindowMs: 1500,
    bodyCaptureMaxBytes: 262144
  },
  redaction: {
    redactHeaders: ["authorization", "cookie", "set-cookie"],
    redactCookieNames: ["token", "session", "auth"],
    redactBodyPatterns: ["password", "token", "secret", "otp"],
    blockedSelectors: [".secret", "[data-sensitive]", "input[type='password']"],
    hashSensitiveValues: true
  },
  sitePolicies: []
};

describe("recorder", () => {
  it("redacts configured sensitive headers", () => {
    const payload = {
      headers: {
        authorization: "Bearer abc",
        "content-type": "application/json"
      },
      token: "abcdef"
    };

    const redacted = redactPayload(payload, TEST_CONFIG.redaction) as {
      headers: Record<string, string>;
      token: string;
    };

    expect(redacted.headers.authorization).not.toBe("Bearer abc");
    expect(redacted.headers["content-type"]).toBe("application/json");
    expect(redacted.token).not.toBe("abcdef");
  });

  it("assigns action span id to dependent events", () => {
    const recorder = new WebBlackboxRecorder(TEST_CONFIG);
    const now = Date.now();

    recorder.ingest({
      source: "content",
      rawType: "click",
      sid: "S-1",
      tabId: 10,
      t: now,
      mono: 100,
      payload: { selector: "button.submit" }
    });

    const result = recorder.ingest({
      source: "cdp",
      rawType: "Network.requestWillBeSent",
      sid: "S-1",
      tabId: 10,
      t: now + 30,
      mono: 120,
      payload: { reqId: "R-1", url: "https://example.com", method: "GET" }
    });

    expect(result.event?.ref?.act).toBeDefined();
  });

  it("returns freeze reason for error events", () => {
    const recorder = new WebBlackboxRecorder(TEST_CONFIG);
    const result = recorder.ingest({
      source: "cdp",
      rawType: "Runtime.exceptionThrown",
      sid: "S-2",
      tabId: 2,
      t: Date.now(),
      mono: 7,
      payload: { message: "boom" }
    });

    expect(result.freezeReason).toBe("error");
  });

  it("normalizes console payloads from cdp and injected hooks", () => {
    const recorder = new WebBlackboxRecorder(TEST_CONFIG);
    const base = Date.now();

    const runtimeConsole = recorder.ingest({
      source: "cdp",
      rawType: "Runtime.consoleAPICalled",
      sid: "S-console",
      tabId: 12,
      t: base,
      mono: 1,
      payload: {
        type: "warning",
        args: [
          { type: "string", value: "hello" },
          { type: "number", value: 42 }
        ],
        stackTrace: {
          callFrames: [
            {
              functionName: "render",
              url: "https://example.com/app.js",
              lineNumber: 10,
              columnNumber: 5
            }
          ]
        }
      }
    });

    const runtimePayload = runtimeConsole.event?.data as
      | {
          source?: string;
          level?: string;
          method?: string;
          text?: string;
          args?: unknown[];
          stackTop?: string;
        }
      | undefined;
    expect(runtimeConsole.event?.type).toBe("console.entry");
    expect(runtimePayload?.source).toBe("cdp.runtime");
    expect(runtimePayload?.level).toBe("warn");
    expect(runtimePayload?.method).toBe("warning");
    expect(runtimePayload?.text).toContain("hello");
    expect(Array.isArray(runtimePayload?.args)).toBe(true);
    expect(runtimePayload?.stackTop).toContain("render");

    const logEntryConsole = recorder.ingest({
      source: "cdp",
      rawType: "Log.entryAdded",
      sid: "S-console",
      tabId: 12,
      t: base + 1,
      mono: 2,
      payload: {
        entry: {
          source: "javascript",
          level: "error",
          text: "boom",
          url: "https://example.com/app.js",
          lineNumber: 22
        }
      }
    });

    const logEntryPayload = logEntryConsole.event?.data as
      | {
          source?: string;
          level?: string;
          method?: string;
          text?: string;
          line?: number;
          url?: string;
        }
      | undefined;
    expect(logEntryConsole.event?.type).toBe("console.entry");
    expect(logEntryPayload?.source).toBe("cdp.log");
    expect(logEntryPayload?.level).toBe("error");
    expect(logEntryPayload?.method).toBe("javascript");
    expect(logEntryPayload?.text).toBe("boom");
    expect(logEntryPayload?.line).toBe(22);

    const injectedConsole = recorder.ingest({
      source: "content",
      rawType: "console",
      sid: "S-console",
      tabId: 12,
      t: base + 2,
      mono: 3,
      payload: {
        source: "injected",
        method: "table",
        level: "log",
        args: [
          "rows",
          {
            total: 3
          }
        ],
        stackTop: "at table (https://example.com/app.js:5:2)"
      }
    });

    const injectedPayload = injectedConsole.event?.data as
      | {
          source?: string;
          level?: string;
          method?: string;
          text?: string;
          stackTop?: string;
        }
      | undefined;
    expect(injectedConsole.event?.type).toBe("console.entry");
    expect(injectedPayload?.source).toBe("injected");
    expect(injectedPayload?.method).toBe("table");
    expect(injectedPayload?.text).toContain("rows");
    expect(injectedPayload?.stackTop).toContain("table");
  });

  it("retains only events in ring buffer time window", () => {
    const buffer = new EventRingBuffer(1);
    const base = Date.now();

    buffer.push({
      v: 1,
      sid: "S",
      tab: 1,
      t: base - 70_000,
      mono: 0,
      type: "sys.notice",
      id: "E-1",
      data: {}
    });

    buffer.push({
      v: 1,
      sid: "S",
      tab: 1,
      t: base,
      mono: 70_000,
      type: "sys.notice",
      id: "E-2",
      data: {}
    });

    expect(buffer.snapshot().map((event) => event.id)).toEqual(["E-2"]);
  });

  it("applies route and error plugins", () => {
    const recorder = new WebBlackboxRecorder(
      TEST_CONFIG,
      {},
      undefined,
      createDefaultRecorderPlugins()
    );
    const base = Date.now();

    const navEvent = recorder.ingest({
      source: "cdp",
      rawType: "Page.frameNavigated",
      sid: "S-plugins",
      tabId: 7,
      t: base,
      mono: 1,
      payload: {
        url: "https://example.com/dashboard"
      }
    });

    const consoleEvent = recorder.ingest({
      source: "cdp",
      rawType: "Runtime.consoleAPICalled",
      sid: "S-plugins",
      tabId: 7,
      t: base + 10,
      mono: 2,
      payload: {
        message: "hello"
      }
    });

    recorder.ingest({
      source: "cdp",
      rawType: "Network.loadingFailed",
      sid: "S-plugins",
      tabId: 7,
      t: base + 15,
      mono: 2.5,
      payload: {
        requestId: "R-77",
        errorText: "net::ERR_TIMED_OUT"
      }
    });

    const errorEvent = recorder.ingest({
      source: "cdp",
      rawType: "Runtime.exceptionThrown",
      sid: "S-plugins",
      tabId: 7,
      t: base + 20,
      mono: 3,
      payload: {
        message: "boom"
      }
    });

    const navPayload = navEvent.event?.data as { routeContext?: { url?: string } } | undefined;
    expect(navPayload?.routeContext?.url).toBe("https://example.com/dashboard");

    const consolePayload = consoleEvent.event?.data as
      | { routeContext?: { url?: string } }
      | undefined;
    expect(consolePayload?.routeContext?.url).toBe("https://example.com/dashboard");

    const errorPayload = errorEvent.event?.data as
      | {
          fingerprint?: string;
          aiRootCause?: {
            plugin?: string;
            suspects?: Array<{ type?: string }>;
          };
        }
      | undefined;
    expect(errorPayload?.fingerprint).toMatch(/^fp-/);
    expect(errorPayload?.aiRootCause?.plugin).toBe("ai-root-cause");
    expect(errorPayload?.aiRootCause?.suspects?.some((suspect) => suspect.type === "network")).toBe(
      true
    );
  });
});
