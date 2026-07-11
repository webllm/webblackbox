/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CAPTURE_POLICY, type CapturePolicy } from "@webblackbox/protocol";

import {
  createAuthenticatedInjectedCaptureConfig,
  createAuthenticatedInjectedCaptureDrainRequest,
  createInjectedLiteCaptureDirectController,
  INJECTED_CAPTURE_CONFIG_EVENT,
  INJECTED_CAPTURE_DRAIN_EVENT,
  INJECTED_MESSAGE_SOURCE,
  parseInjectedCaptureArmedMessage,
  parseInjectedCaptureConfig,
  parseInjectedCaptureDrainedMessage,
  parseInjectedCaptureWindowMessage,
  type InjectedCaptureArmedMessage,
  type InjectedCaptureConfig,
  type InjectedCaptureWindowMessage,
  type InjectedDirectDrainResult,
  installInjectedLiteCaptureHooks,
  verifyAuthenticatedInjectedCaptureControlAck
} from "./injected-hooks.js";

type CaptureEventMessage = {
  activationId: string;
  rawType: string;
  payload: Record<string, unknown>;
  t: number;
  mono: number;
};

const ACTIVATION_A = `a1_${"a".repeat(64)}`;
const ACTIVATION_B = `a1_${"b".repeat(64)}`;

const DETAILED_TEST_CAPTURE_POLICY: CapturePolicy = {
  ...DEFAULT_CAPTURE_POLICY,
  mode: "debug",
  categories: {
    ...DEFAULT_CAPTURE_POLICY.categories,
    console: "allow",
    network: "body-allowlist",
    storage: "allow"
  }
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("injected-hooks", () => {
  const originalFetch = window.fetch;
  const captured: CaptureEventMessage[] = [];
  const armed: string[] = [];

  beforeEach(() => {
    captured.length = 0;
    armed.length = 0;
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
      const row = message as InjectedCaptureWindowMessage | InjectedCaptureArmedMessage;

      if (row?.source !== INJECTED_MESSAGE_SOURCE) {
        return;
      }

      if (row.kind === "injected-armed") {
        armed.push(row.activationId);
        return;
      }

      if (row.kind === "capture-event") {
        captured.push({
          activationId: row.activationId,
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
    vi.unstubAllGlobals();
    window.fetch = originalFetch;
    localStorage.clear();
    sessionStorage.clear();
  });

  it("accepts only bounded observation messages from the page-world bridge", () => {
    const validEvent = {
      activationId: ACTIVATION_A,
      rawType: "console",
      payload: { method: "info", redacted: true },
      t: Date.now(),
      mono: performance.timeOrigin + performance.now()
    };

    expect(
      parseInjectedCaptureWindowMessage({
        source: INJECTED_MESSAGE_SOURCE,
        kind: "capture-events",
        activationId: ACTIVATION_A,
        events: [validEvent]
      })
    ).toEqual([validEvent]);

    expect(
      parseInjectedCaptureWindowMessage({
        source: INJECTED_MESSAGE_SOURCE,
        kind: "marker",
        message: "forged control action",
        t: Date.now(),
        mono: performance.now()
      })
    ).toBeNull();

    expect(
      parseInjectedCaptureWindowMessage({
        source: INJECTED_MESSAGE_SOURCE,
        kind: "capture-event",
        ...validEvent,
        rawType: "mutation"
      })
    ).toBeNull();

    expect(
      parseInjectedCaptureWindowMessage({
        source: INJECTED_MESSAGE_SOURCE,
        kind: "capture-events",
        activationId: ACTIVATION_A,
        events: Array.from({ length: 25 }, () => validEvent)
      })
    ).toBeNull();

    let nestedPayload: Record<string, unknown> = {};
    for (let depth = 0; depth < 8; depth += 1) {
      nestedPayload = { nested: nestedPayload };
    }
    expect(
      parseInjectedCaptureWindowMessage({
        source: INJECTED_MESSAGE_SOURCE,
        kind: "capture-event",
        ...validEvent,
        payload: nestedPayload
      })
    ).toBeNull();

    expect(
      parseInjectedCaptureWindowMessage(
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error("hostile proxy");
            }
          }
        )
      )
    ).toBeNull();
  });

  it("strictly binds configs, acknowledgements, and batches to one activation", () => {
    const event = {
      activationId: ACTIVATION_A,
      rawType: "console",
      payload: { method: "info", redacted: true },
      t: 1,
      mono: 1
    };

    expect(
      parseInjectedCaptureConfig({
        active: true,
        activationId: ACTIVATION_A,
        bodyCaptureMaxBytes: 4_096,
        capturePolicy: DEFAULT_CAPTURE_POLICY
      })
    ).toMatchObject({ active: true, activationId: ACTIVATION_A });
    expect(
      parseInjectedCaptureConfig({
        active: true,
        activationId: ACTIVATION_A,
        unexpected: true
      })
    ).toBeNull();
    expect(parseInjectedCaptureConfig({ active: true, activationId: "a1_short" })).toBeNull();

    expect(
      parseInjectedCaptureArmedMessage({
        source: INJECTED_MESSAGE_SOURCE,
        kind: "injected-armed",
        activationId: ACTIVATION_A
      })
    ).toBe(ACTIVATION_A);
    expect(
      parseInjectedCaptureArmedMessage({
        source: INJECTED_MESSAGE_SOURCE,
        kind: "injected-armed",
        activationId: ACTIVATION_A,
        events: []
      })
    ).toBeNull();

    expect(
      parseInjectedCaptureWindowMessage({
        source: INJECTED_MESSAGE_SOURCE,
        kind: "capture-events",
        activationId: ACTIVATION_A,
        events: [event, { ...event, activationId: ACTIVATION_B }]
      })
    ).toBeNull();
  });

  it("flushes queued events on deactivation but drops stale replacement flushes", async () => {
    vi.useFakeTimers();
    const flag = "__WB_TEST_INJECTED_ACTIVATION_RESET__";

    try {
      installInjectedLiteCaptureHooks({ flag, active: false });
      window.dispatchEvent(
        new CustomEvent<InjectedCaptureConfig>(INJECTED_CAPTURE_CONFIG_EVENT, {
          detail: { active: true, activationId: ACTIVATION_A }
        })
      );
      console.info("queued-under-a");
      window.dispatchEvent(
        new CustomEvent<InjectedCaptureConfig>(INJECTED_CAPTURE_CONFIG_EVENT, {
          detail: { active: false, activationId: ACTIVATION_A }
        })
      );
      await vi.runAllTimersAsync();

      expect(captured.some((event) => event.activationId === ACTIVATION_A)).toBe(true);
      captured.length = 0;

      window.dispatchEvent(
        new CustomEvent<InjectedCaptureConfig>(INJECTED_CAPTURE_CONFIG_EVENT, {
          detail: { active: true, activationId: ACTIVATION_A }
        })
      );
      console.info("replaced-a");
      window.dispatchEvent(
        new CustomEvent<InjectedCaptureConfig>(INJECTED_CAPTURE_CONFIG_EVENT, {
          detail: { active: true, activationId: ACTIVATION_B }
        })
      );
      console.info("active-b");
      await vi.runAllTimersAsync();

      expect(captured.some((event) => event.activationId === ACTIVATION_A)).toBe(false);
      expect(captured.some((event) => event.activationId === ACTIVATION_B)).toBe(true);
      expect(armed).toEqual(expect.arrayContaining([ACTIVATION_A, ACTIVATION_B]));
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("flushes MAIN events before emitting the close-only drain barrier", async () => {
    vi.useFakeTimers();
    const flag = "__WB_TEST_INJECTED_DRAIN__";

    try {
      installInjectedLiteCaptureHooks({ flag, active: false });
      window.dispatchEvent(
        new CustomEvent<InjectedCaptureConfig>(INJECTED_CAPTURE_CONFIG_EVENT, {
          detail: { active: true, activationId: ACTIVATION_A }
        })
      );
      console.info("queued-before-drain");
      window.dispatchEvent(
        new CustomEvent(INJECTED_CAPTURE_DRAIN_EVENT, {
          detail: { activationId: ACTIVATION_A }
        })
      );
      await vi.runAllTimersAsync();

      expect(captured.some((event) => event.activationId === ACTIVATION_A)).toBe(true);
      expect(window.postMessage).toHaveBeenCalledWith(
        {
          source: INJECTED_MESSAGE_SOURCE,
          kind: "injected-drained",
          activationId: ACTIVATION_A
        },
        "*"
      );
      expect(
        parseInjectedCaptureDrainedMessage({
          source: INJECTED_MESSAGE_SOURCE,
          kind: "injected-drained",
          activationId: ACTIVATION_A
        })
      ).toBe(ACTIVATION_A);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("rejects a page-preempted drain and accepts only the HMAC-authenticated barrier", async () => {
    const secret = "c".repeat(64);
    const flag = "__WB_TEST_AUTHENTICATED_DRAIN__";
    let forgedAck: unknown;
    const preempt = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      forgedAck = {
        source: INJECTED_MESSAGE_SOURCE,
        kind: "injected-drained-authenticated",
        activationId: detail.activationId,
        nonce: detail.nonce,
        proof: "0".repeat(64)
      };
      window.postMessage(forgedAck, "*");
    };
    window.addEventListener(INJECTED_CAPTURE_DRAIN_EVENT, preempt);

    try {
      expect(
        installInjectedLiteCaptureHooks({
          flag,
          active: false,
          captureNetwork: false,
          controlSecret: secret
        })
      ).toBe(secret);
      const config = await createAuthenticatedInjectedCaptureConfig(secret, {
        active: true,
        activationId: ACTIVATION_A,
        bodyCaptureMaxBytes: 0,
        capturePolicy: DETAILED_TEST_CAPTURE_POLICY
      });
      window.dispatchEvent(new CustomEvent(INJECTED_CAPTURE_CONFIG_EVENT, { detail: config }));
      await delay(10);
      console.info("authenticated-tail");
      const drain = await createAuthenticatedInjectedCaptureDrainRequest(secret, ACTIVATION_A);
      window.dispatchEvent(new CustomEvent(INJECTED_CAPTURE_DRAIN_EVENT, { detail: drain }));
      await delay(10);

      expect(
        await verifyAuthenticatedInjectedCaptureControlAck(forgedAck, secret, {
          kind: "injected-drained-authenticated",
          activationId: ACTIVATION_A,
          nonce: drain.nonce
        })
      ).toBe(false);
      const authenticatedAck = vi
        .mocked(window.postMessage)
        .mock.calls.map(([message]) => message)
        .filter(
          (message) => (message as { kind?: unknown }).kind === "injected-drained-authenticated"
        )
        .at(-1);
      expect(
        await verifyAuthenticatedInjectedCaptureControlAck(authenticatedAck, secret, {
          kind: "injected-drained-authenticated",
          activationId: ACTIVATION_A,
          nonce: drain.nonce
        })
      ).toBe(true);
      expect(captured.some((event) => event.activationId === ACTIVATION_A)).toBe(true);
    } finally {
      window.removeEventListener(INJECTED_CAPTURE_DRAIN_EVENT, preempt);
    }
  });

  it("locks control closed at the nonce limit and never accepts an evicted active replay", async () => {
    const secret = "d".repeat(64);
    installInjectedLiteCaptureHooks({
      flag: "__WB_TEST_CONTROL_NONCE_LIMIT__",
      active: false,
      captureNetwork: false,
      controlSecret: secret,
      controlNonceLimit: 2
    });
    const first = await createAuthenticatedInjectedCaptureConfig(secret, {
      active: true,
      activationId: ACTIVATION_A
    });
    const second = await createAuthenticatedInjectedCaptureConfig(secret, {
      active: false,
      activationId: ACTIVATION_A
    });
    const overflow = await createAuthenticatedInjectedCaptureConfig(secret, {
      active: true,
      activationId: ACTIVATION_B
    });

    for (const detail of [first, second, overflow, first]) {
      window.dispatchEvent(new CustomEvent(INJECTED_CAPTURE_CONFIG_EVENT, { detail }));
      await delay(5);
    }
    captured.length = 0;
    console.info("must-remain-locked");
    await delay(10);

    expect(captured).toEqual([]);
  });

  it("keeps asynchronous network completions bound to their producing activation", async () => {
    let resolveFetch!: (response: Response) => void;
    window.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    ) as typeof fetch;
    installInjectedLiteCaptureHooks({
      flag: "__WB_TEST_INJECTED_ASYNC_ACTIVATION__",
      active: true,
      activationId: ACTIVATION_A,
      capturePolicy: DETAILED_TEST_CAPTURE_POLICY
    });

    const request = window.fetch("https://example.test/deferred");
    window.dispatchEvent(
      new CustomEvent<InjectedCaptureConfig>(INJECTED_CAPTURE_CONFIG_EVENT, {
        detail: {
          active: true,
          activationId: ACTIVATION_B,
          capturePolicy: DETAILED_TEST_CAPTURE_POLICY
        }
      })
    );
    resolveFetch(
      new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" }
      })
    );
    await request;
    await delay(10);

    expect(
      captured.some(
        (event) =>
          event.rawType === "fetch" ||
          event.rawType === "fetchError" ||
          event.rawType === "networkBody"
      )
    ).toBe(false);
  });

  it("omits IndexedDB names when policy is counts-only", async () => {
    const open = vi.fn(() => ({}) as IDBOpenDBRequest);
    vi.stubGlobal("indexedDB", { open });

    installInjectedLiteCaptureHooks({
      flag: "__WB_TEST_INJECTED_IDB_COUNTS_ONLY__",
      capturePolicy: DETAILED_TEST_CAPTURE_POLICY
    });

    indexedDB.open("customer-secret-db", 7);
    await delay(10);

    const event = captured.find((message) => message.rawType === "indexedDbOp");
    expect(event?.payload).toEqual({ op: "open" });
    expect(JSON.stringify(event)).not.toContain("customer-secret-db");
    expect(open).toHaveBeenCalledWith("customer-secret-db", 7);
  });

  it("retains IndexedDB names only when names-only policy explicitly allows them", async () => {
    const open = vi.fn(() => ({}) as IDBOpenDBRequest);
    vi.stubGlobal("indexedDB", { open });
    const capturePolicy: CapturePolicy = {
      ...DETAILED_TEST_CAPTURE_POLICY,
      categories: {
        ...DETAILED_TEST_CAPTURE_POLICY.categories,
        indexedDb: "names-only"
      }
    };

    installInjectedLiteCaptureHooks({
      flag: "__WB_TEST_INJECTED_IDB_NAMES_ONLY__",
      capturePolicy
    });

    indexedDB.open("allowed-database-name", 3);
    await delay(10);

    const event = captured.find((message) => message.rawType === "indexedDbOp");
    expect(event?.payload).toEqual({
      op: "open",
      name: "allowed-database-name",
      version: 3
    });
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
      level: "info",
      redacted: true
    });
    expect((event?.payload as { text?: unknown }).text).toBeUndefined();
    expect((event?.payload as { args?: unknown }).args).toBeUndefined();
  });

  it("keeps the installed state when a duplicate bootstrap supplies different options", async () => {
    const flag = "__WB_TEST_INJECTED_DUPLICATE_BOOTSTRAP__";
    const configEvents = vi.fn();
    window.fetch = vi.fn(async () => {
      return new Response('{"ok":true}', {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    }) as typeof fetch;
    window.addEventListener(INJECTED_CAPTURE_CONFIG_EVENT, configEvents);

    try {
      installInjectedLiteCaptureHooks({
        flag,
        active: true,
        activationId: ACTIVATION_A,
        bodyCaptureMaxBytes: 64 * 1024,
        capturePolicy: DETAILED_TEST_CAPTURE_POLICY
      });
      const installedFetch = window.fetch;
      const installedConsoleInfo = console.info;

      installInjectedLiteCaptureHooks({
        flag,
        active: false,
        activationId: ACTIVATION_B,
        bodyCaptureMaxBytes: 0,
        capturePolicy: DEFAULT_CAPTURE_POLICY,
        captureNetwork: false
      });

      expect(window.fetch).toBe(installedFetch);
      expect(console.info).toBe(installedConsoleInfo);
      expect(configEvents).not.toHaveBeenCalled();

      console.info("still-active-after-duplicate-bootstrap");
      await window.fetch("https://example.test/api/duplicate-bootstrap");

      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (captured.some((message) => message.rawType === "networkBody")) {
          break;
        }

        await delay(5);
      }

      expect(
        captured.filter(
          (message) =>
            message.rawType === "notice" &&
            (message.payload as { message?: unknown }).message === "injected-ready"
        )
      ).toHaveLength(1);
      expect(captured.some((message) => message.rawType === "console")).toBe(true);
      expect(captured.some((message) => message.rawType === "networkBody")).toBe(true);

      const consoleCountBeforeInactive = captured.filter(
        (message) => message.rawType === "console"
      ).length;
      const bodyCountBeforeInactive = captured.filter(
        (message) => message.rawType === "networkBody"
      ).length;
      window.dispatchEvent(
        new CustomEvent<InjectedCaptureConfig>(INJECTED_CAPTURE_CONFIG_EVENT, {
          detail: {
            active: false,
            activationId: ACTIVATION_A,
            bodyCaptureMaxBytes: 0
          }
        })
      );
      console.info("inactive-after-dynamic-config");
      await window.fetch("https://example.test/api/inactive-after-config");
      await delay(10);

      expect(captured.filter((message) => message.rawType === "console")).toHaveLength(
        consoleCountBeforeInactive
      );
      expect(captured.filter((message) => message.rawType === "networkBody")).toHaveLength(
        bodyCountBeforeInactive
      );

      window.dispatchEvent(
        new CustomEvent<InjectedCaptureConfig>(INJECTED_CAPTURE_CONFIG_EVENT, {
          detail: {
            active: true,
            activationId: ACTIVATION_A,
            bodyCaptureMaxBytes: 64 * 1024
          }
        })
      );
      console.info("active-after-dynamic-config");
      await delay(10);

      expect(captured.filter((message) => message.rawType === "console")).toHaveLength(
        consoleCountBeforeInactive + 1
      );
      expect(configEvents).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(INJECTED_CAPTURE_CONFIG_EVENT, configEvents);
    }
  });

  it("captures fetch start/end and sampled response body", async () => {
    const flag = "__WB_TEST_INJECTED_FETCH__";

    window.fetch = vi.fn(async () => {
      return new Response('{"ok":true,"token":"abc"}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-user-email": "alice@example.test"
        }
      });
    }) as typeof fetch;

    installInjectedLiteCaptureHooks({
      flag,
      bodyCaptureMaxBytes: 128 * 1024,
      capturePolicy: DETAILED_TEST_CAPTURE_POLICY
    });

    await window.fetch("https://example.test/api/demo/123?token=secret#frag", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-user-email": "alice@example.test",
        authorization: "Bearer abc"
      },
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
      url: "https://example.test/api/demo/:id",
      headers: {
        "content-type": "application/json"
      }
    });
    expect(JSON.stringify(fetchStart?.payload)).not.toContain("alice@example.test");
    expect(JSON.stringify(fetchStart?.payload)).not.toContain("Bearer abc");
    expect(fetchEnd?.payload).toMatchObject({
      status: 200,
      ok: true,
      headers: {
        "content-type": "application/json"
      }
    });
    expect(JSON.stringify(fetchEnd?.payload)).not.toContain("alice@example.test");
    expect(networkBody?.payload).toMatchObject({
      source: "fetch",
      method: "POST",
      status: 200,
      mimeType: "application/json",
      encoding: "utf8"
    });
    expect(String((networkBody?.payload as { body?: unknown }).body ?? "")).toContain('"ok":true');
  });

  it("does not sample fetch bodies without an allowed content type", async () => {
    const flag = "__WB_TEST_INJECTED_FETCH_MISSING_MIME__";

    window.fetch = vi.fn(async () => {
      return new Response(new Uint8Array([0, 1, 2, 3]), {
        status: 200
      });
    }) as typeof fetch;

    installInjectedLiteCaptureHooks({
      flag,
      bodyCaptureMaxBytes: 128 * 1024,
      capturePolicy: DETAILED_TEST_CAPTURE_POLICY
    });

    await window.fetch("https://example.test/api/binary");
    await delay(20);

    expect(captured.some((message) => message.rawType === "networkBody")).toBe(false);
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

    installInjectedLiteCaptureHooks({ flag, activationId: ACTIVATION_A });

    await window.fetch("https://example.test/api/disabled");
    await delay(20);

    expect(captured.some((message) => message.rawType === "networkBody")).toBe(false);

    window.dispatchEvent(
      new CustomEvent<InjectedCaptureConfig>(INJECTED_CAPTURE_CONFIG_EVENT, {
        detail: {
          active: true,
          activationId: ACTIVATION_A,
          bodyCaptureMaxBytes: 64 * 1024,
          capturePolicy: DETAILED_TEST_CAPTURE_POLICY
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
          active: true,
          activationId: ACTIVATION_A
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
          active: false,
          activationId: ACTIVATION_A
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
    installInjectedLiteCaptureHooks({ flag, capturePolicy: DETAILED_TEST_CAPTURE_POLICY });

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
    installInjectedLiteCaptureHooks({ flag, capturePolicy: DETAILED_TEST_CAPTURE_POLICY });

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

  it("keeps direct control privileged, monotonic, replayable, and free of DOM crypto control", () => {
    const secret = "e".repeat(64);
    const wrongSecret = "f".repeat(64);
    const addEventListener = vi.spyOn(window, "addEventListener");
    const getRandomValues = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementation(() => {
        throw new Error("page crypto must not be used by direct control");
      });
    const jsonStringify = vi.spyOn(JSON, "stringify");
    const OriginalTextEncoder = globalThis.TextEncoder;
    const textEncoder = vi.fn(() => {
      throw new Error("page TextEncoder must not be used by direct control");
    });
    vi.stubGlobal("TextEncoder", textEncoder);

    const controller = createInjectedLiteCaptureDirectController({ replayEventLimit: 2 });
    expect(controller.bootstrap(secret)).toEqual({
      kind: "installed",
      phase: "inactive",
      revision: 0
    });
    expect(controller.bootstrap(secret)).toEqual({
      kind: "existing",
      phase: "inactive",
      revision: 0
    });
    expect(controller.bootstrap(wrongSecret)).toEqual({ kind: "rejected" });
    expect(
      addEventListener.mock.calls.some(
        ([type]) =>
          String(type) === INJECTED_CAPTURE_CONFIG_EVENT ||
          String(type) === INJECTED_CAPTURE_DRAIN_EVENT
      )
    ).toBe(false);

    const poisonCommand: Record<string, unknown> = {};
    Object.defineProperty(poisonCommand, "kind", {
      get(): never {
        throw new Error("wrong capability must not inspect the command");
      }
    });
    expect(() => controller.control(wrongSecret, poisonCommand)).not.toThrow();
    expect(controller.control(wrongSecret, poisonCommand)).toEqual({
      kind: "rejected",
      reason: "capability"
    });
    expect(
      controller.control(secret, {
        kind: "activate",
        revision: 1,
        config: { active: true, activationId: ACTIVATION_A },
        extra: true
      })
    ).toEqual({ kind: "rejected", reason: "invalid-command" });

    expect(
      controller.control(secret, {
        kind: "activate",
        revision: 1,
        config: {
          active: true,
          activationId: ACTIVATION_A,
          bodyCaptureMaxBytes: 0,
          capturePolicy: DETAILED_TEST_CAPTURE_POLICY
        }
      })
    ).toEqual({ kind: "activated", activationId: ACTIVATION_A, revision: 1 });
    expect(controller.control(secret, { kind: "probe" })).toMatchObject({
      kind: "probed",
      phase: "active",
      revision: 1,
      activationId: ACTIVATION_A
    });
    expect(getRandomValues).not.toHaveBeenCalled();
    expect(textEncoder).not.toHaveBeenCalled();
    expect(jsonStringify).not.toHaveBeenCalled();

    getRandomValues.mockRestore();
    vi.stubGlobal("TextEncoder", OriginalTextEncoder);
    console.info("direct-tail-1");
    console.info("direct-tail-2");
    const firstDrain = controller.control(secret, {
      kind: "drain",
      revision: 2,
      activationId: ACTIVATION_A
    }) as InjectedDirectDrainResult;
    expect(firstDrain).toMatchObject({
      kind: "drained",
      activationId: ACTIVATION_A,
      revision: 2,
      producedThrough: 2,
      truncatedBefore: 0,
      degraded: false,
      replayed: false
    });
    expect(firstDrain.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(firstDrain.events.every((event) => event.activationId === ACTIVATION_A)).toBe(true);

    expect(
      controller.control(secret, {
        kind: "drain",
        revision: 2,
        activationId: ACTIVATION_A
      })
    ).toEqual({ kind: "rejected", reason: "stale" });
    expect(
      controller.control(secret, {
        kind: "drain",
        revision: 3,
        activationId: ACTIVATION_A
      })
    ).toMatchObject({
      kind: "drained",
      replayed: true,
      producedThrough: 2,
      truncatedBefore: 0
    });

    expect(
      controller.control(secret, {
        kind: "activate",
        revision: 4,
        config: {
          active: true,
          activationId: ACTIVATION_B,
          bodyCaptureMaxBytes: 0,
          capturePolicy: DETAILED_TEST_CAPTURE_POLICY
        }
      })
    ).toEqual({ kind: "activated", activationId: ACTIVATION_B, revision: 4 });
    expect(
      controller.control(secret, {
        kind: "drain",
        revision: 5,
        activationId: ACTIVATION_A
      })
    ).toEqual({ kind: "rejected", reason: "activation-mismatch" });
    expect(controller.control(secret, { kind: "probe" })).toMatchObject({
      kind: "probed",
      phase: "active",
      revision: 4,
      activationId: ACTIVATION_B
    });

    console.info("direct-overflow-1");
    console.info("direct-overflow-2");
    console.info("direct-overflow-3");
    const overflowDrain = controller.control(secret, {
      kind: "drain",
      revision: 5,
      activationId: ACTIVATION_B
    }) as InjectedDirectDrainResult;
    expect(overflowDrain).toMatchObject({
      producedThrough: 3,
      truncatedBefore: 1,
      degraded: true,
      replayed: false
    });
    expect(overflowDrain.events.map((event) => event.seq)).toEqual([2, 3]);

    let nextRevision = 6;
    for (let lifecycle = 0; lifecycle < 520; lifecycle += 1) {
      const activationId = `a1_${lifecycle.toString(16).padStart(64, "0")}`;
      expect(
        controller.control(secret, {
          kind: "activate",
          revision: nextRevision,
          config: { active: true, activationId }
        })
      ).toMatchObject({ kind: "activated", activationId });
      nextRevision += 1;
      expect(
        controller.control(secret, {
          kind: "drain",
          revision: nextRevision,
          activationId
        })
      ).toMatchObject({ kind: "drained", activationId, degraded: false });
      nextRevision += 1;
    }

    expect(controller.control(secret, { kind: "probe" })).toMatchObject({
      kind: "probed",
      phase: "drained",
      revision: nextRevision - 1
    });
  });

  it("clears the controlled activation on direct deactivation", () => {
    const secret = "8".repeat(64);
    const controller = createInjectedLiteCaptureDirectController();
    expect(controller.bootstrap(secret)).toMatchObject({ kind: "installed" });
    expect(
      controller.control(secret, {
        kind: "activate",
        revision: 1,
        config: { active: true, activationId: ACTIVATION_A }
      })
    ).toMatchObject({ kind: "activated" });
    expect(
      controller.control(secret, {
        kind: "deactivate",
        revision: 2,
        activationId: ACTIVATION_A
      })
    ).toMatchObject({ kind: "deactivated" });
    expect(controller.control(secret, { kind: "probe" })).toMatchObject({
      kind: "probed",
      phase: "inactive",
      revision: 2,
      activationId: null
    });
  });

  it("atomically replaces an active activation at a higher revision", () => {
    const secret = "7".repeat(64);
    const controller = createInjectedLiteCaptureDirectController();
    controller.bootstrap(secret);
    expect(
      controller.control(secret, {
        kind: "activate",
        revision: 1,
        config: { active: true, activationId: ACTIVATION_A }
      })
    ).toMatchObject({ kind: "activated", activationId: ACTIVATION_A });
    console.info("old-activation-tail");
    expect(
      controller.control(secret, {
        kind: "activate",
        revision: 2,
        config: { active: true, activationId: ACTIVATION_B }
      })
    ).toMatchObject({ kind: "activated", activationId: ACTIVATION_B });
    expect(
      controller.control(secret, {
        kind: "drain",
        revision: 3,
        activationId: ACTIVATION_A
      })
    ).toEqual({ kind: "rejected", reason: "activation-mismatch" });
    expect(controller.control(secret, { kind: "probe" })).toMatchObject({
      phase: "active",
      activationId: ACTIVATION_B,
      producedThrough: 0,
      truncatedBefore: 0
    });
  });

  it("bounds direct replay by estimated serialized bytes as well as event count", () => {
    const secret = "9".repeat(64);
    const controller = createInjectedLiteCaptureDirectController({
      replayByteLimit: 128,
      replayEventLimit: 256
    });

    expect(controller.bootstrap(secret)).toMatchObject({ kind: "installed" });
    expect(
      controller.control(secret, {
        kind: "activate",
        revision: 1,
        config: {
          active: true,
          activationId: ACTIVATION_A,
          capturePolicy: DETAILED_TEST_CAPTURE_POLICY
        }
      })
    ).toMatchObject({ kind: "activated" });

    console.info("x".repeat(1_000));
    const result = controller.control(secret, {
      kind: "drain",
      revision: 2,
      activationId: ACTIVATION_A
    }) as InjectedDirectDrainResult;

    expect(result).toMatchObject({
      kind: "drained",
      producedThrough: 1,
      truncatedBefore: 1,
      degraded: true
    });
    expect(result.events).toEqual([]);
  });
});
