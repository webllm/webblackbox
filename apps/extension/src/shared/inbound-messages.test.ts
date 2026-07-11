import { describe, expect, it } from "vitest";

import type { MessageSenderLike } from "./chrome-api.js";
import {
  isAuthorizedExtensionPort,
  parseExtensionInboundMessage,
  type ExtensionInboundContext
} from "./inbound-messages.js";
import { CONTENT_EVENT_BATCH_MAX, PORT_NAMES } from "./messages.js";

const EXTENSION_BASE_URL = "chrome-extension://webblackbox-test/";
const STOP_DRAIN_TOKEN = "a".repeat(64);
const READY_ID = `r1_${"b".repeat(64)}`;
const ACTIVATION_ID = `a1_${"c".repeat(64)}`;
const BATCH_ID = `b1_${"d".repeat(64)}`;

const POPUP_SENDER: MessageSenderLike = {
  url: `${EXTENSION_BASE_URL}popup.html`,
  origin: "chrome-extension://webblackbox-test"
};

const SESSIONS_SENDER: MessageSenderLike = {
  url: `${EXTENSION_BASE_URL}sessions.html`,
  origin: "chrome-extension://webblackbox-test"
};

const CONTENT_SENDER: MessageSenderLike = {
  documentId: "document-42",
  frameId: 0,
  url: "https://app.example.test/dashboard",
  origin: "https://app.example.test",
  tab: {
    id: 42,
    url: "https://app.example.test/dashboard"
  }
};

function portContext(portName: string, sender: MessageSenderLike): ExtensionInboundContext {
  return {
    transport: "port",
    portName,
    sender,
    extensionBaseUrl: EXTENSION_BASE_URL
  };
}

function runtimeContext(sender: MessageSenderLike): ExtensionInboundContext {
  return {
    transport: "runtime",
    sender,
    extensionBaseUrl: EXTENSION_BASE_URL
  };
}

function validRawEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "content",
    rawType: "click",
    tabId: 42,
    sid: "S-content",
    t: 1_720_000_000_000,
    mono: 123.5,
    payload: {
      x: 14,
      y: 21,
      target: {
        tag: "BUTTON"
      }
    },
    ...overrides
  };
}

function contentBatch(events: unknown[]): Record<string, unknown> {
  return {
    kind: "content.events",
    activationId: ACTIVATION_ID,
    batchId: BATCH_ID,
    events,
    documentUrl: "https://app.example.test/dashboard"
  };
}

describe("extension inbound source authorization", () => {
  it("binds named ports to their real extension page or tab/frame sender", () => {
    expect(
      isAuthorizedExtensionPort(
        { name: PORT_NAMES.popup, sender: POPUP_SENDER },
        EXTENSION_BASE_URL
      )
    ).toBe(true);
    expect(
      isAuthorizedExtensionPort(
        { name: PORT_NAMES.sessions, sender: SESSIONS_SENDER },
        EXTENSION_BASE_URL
      )
    ).toBe(true);
    expect(
      isAuthorizedExtensionPort(
        { name: PORT_NAMES.content, sender: CONTENT_SENDER },
        EXTENSION_BASE_URL
      )
    ).toBe(true);

    expect(
      isAuthorizedExtensionPort(
        { name: PORT_NAMES.popup, sender: CONTENT_SENDER },
        EXTENSION_BASE_URL
      )
    ).toBe(false);
    expect(
      isAuthorizedExtensionPort(
        { name: PORT_NAMES.content, sender: POPUP_SENDER },
        EXTENSION_BASE_URL
      )
    ).toBe(false);
    expect(
      isAuthorizedExtensionPort(
        {
          name: PORT_NAMES.popup,
          sender: { url: `${EXTENSION_BASE_URL}sessions.html` }
        },
        EXTENSION_BASE_URL
      )
    ).toBe(false);
    expect(
      isAuthorizedExtensionPort(
        { name: "webblackbox:spoofed", sender: POPUP_SENDER },
        EXTENSION_BASE_URL
      )
    ).toBe(false);
  });

  it("prevents a content sender from forging UI controls", () => {
    expect(
      parseExtensionInboundMessage(
        { kind: "ui.stop", tabId: 42 },
        portContext(PORT_NAMES.content, CONTENT_SENDER)
      )
    ).toBeNull();
    expect(
      parseExtensionInboundMessage(
        { kind: "ui.export", sid: "session-1", passphrase: "secret" },
        runtimeContext(CONTENT_SENDER)
      )
    ).toBeNull();
    expect(
      parseExtensionInboundMessage(
        contentBatch([validRawEvent()]),
        portContext(PORT_NAMES.popup, POPUP_SENDER)
      )
    ).toBeNull();
    expect(
      parseExtensionInboundMessage(
        { kind: "ui.start", mode: "lite", tabId: 42 },
        portContext(PORT_NAMES.sessions, SESSIONS_SENDER)
      )
    ).toBeNull();
  });

  it("only permits the one-off messages used by each trusted sender", () => {
    expect(
      parseExtensionInboundMessage(
        { kind: "ui.start", mode: "lite", tabId: 42 },
        runtimeContext(POPUP_SENDER)
      )
    ).toEqual({ kind: "ui.start", mode: "lite", tabId: 42 });
    expect(
      parseExtensionInboundMessage({ kind: "ui.stop", tabId: 42 }, runtimeContext(POPUP_SENDER))
    ).toBeNull();
    expect(
      parseExtensionInboundMessage(
        {
          kind: "content.ready",
          readyId: READY_ID,
          reason: "recovery",
          mainWorldController: null,
          documentUrl: CONTENT_SENDER.url
        },
        runtimeContext(CONTENT_SENDER)
      )
    ).toEqual({
      kind: "content.ready",
      readyId: READY_ID,
      reason: "recovery",
      mainWorldController: null,
      documentUrl: CONTENT_SENDER.url
    });
    expect(
      parseExtensionInboundMessage(
        {
          kind: "content.armed",
          readyId: READY_ID,
          activationId: ACTIVATION_ID,
          documentUrl: CONTENT_SENDER.url
        },
        runtimeContext(CONTENT_SENDER)
      )
    ).not.toBeNull();
    expect(
      parseExtensionInboundMessage(
        {
          kind: "content.main-world-control",
          activationId: ACTIVATION_ID,
          documentUrl: CONTENT_SENDER.url,
          operation: "drain"
        },
        runtimeContext(CONTENT_SENDER)
      )
    ).not.toBeNull();
    expect(
      parseExtensionInboundMessage(
        {
          kind: "content.bind",
          activationId: ACTIVATION_ID,
          documentUrl: CONTENT_SENDER.url
        },
        runtimeContext(CONTENT_SENDER)
      )
    ).toBeNull();
    expect(
      parseExtensionInboundMessage(contentBatch([validRawEvent()]), runtimeContext(CONTENT_SENDER))
    ).toBeNull();
    expect(
      parseExtensionInboundMessage(
        { kind: "ui.start", mode: "lite", tabId: 42 },
        runtimeContext({ ...CONTENT_SENDER, url: "https://attacker.example/" })
      )
    ).toBeNull();
  });
});

describe("extension inbound schema validation", () => {
  it("accepts canonical UI messages and copies their bounded fields", () => {
    const start = parseExtensionInboundMessage(
      {
        kind: "ui.start",
        tabId: 42,
        mode: "full",
        reloadPage: false,
        visualCapture: "both",
        recordScreen: true
      },
      portContext(PORT_NAMES.popup, POPUP_SENDER)
    );
    const exportMessage = parseExtensionInboundMessage(
      {
        kind: "ui.export",
        sid: "session-1",
        passphrase: "correct horse battery staple",
        saveAs: false,
        policy: {
          includeScreenshots: true,
          includeScreenRecordings: false,
          maxArchiveBytes: 100 * 1024 * 1024,
          recentWindowMs: 20 * 60 * 1000
        }
      },
      portContext(PORT_NAMES.popup, POPUP_SENDER)
    );
    const annotate = parseExtensionInboundMessage(
      {
        kind: "ui.annotate",
        sid: "session-1",
        tags: [],
        note: "Reproduced once"
      },
      portContext(PORT_NAMES.sessions, SESSIONS_SENDER)
    );

    expect(start).toEqual({
      kind: "ui.start",
      tabId: 42,
      mode: "full",
      reloadPage: false,
      visualCapture: "both",
      recordScreen: true
    });
    expect(exportMessage).toEqual({
      kind: "ui.export",
      sid: "session-1",
      passphrase: "correct horse battery staple",
      saveAs: false,
      policy: {
        includeScreenshots: true,
        includeScreenRecordings: false,
        maxArchiveBytes: 100 * 1024 * 1024,
        recentWindowMs: 20 * 60 * 1000
      }
    });
    expect(annotate).toEqual({
      kind: "ui.annotate",
      sid: "session-1",
      tags: [],
      note: "Reproduced once"
    });
  });

  it("rejects unknown fields, invalid enums, non-finite numbers, and excessive UI data", () => {
    const popup = portContext(PORT_NAMES.popup, POPUP_SENDER);
    const sessions = portContext(PORT_NAMES.sessions, SESSIONS_SENDER);

    expect(
      parseExtensionInboundMessage(
        { kind: "ui.start", mode: "lite", tabId: 42, admin: true },
        popup
      )
    ).toBeNull();
    expect(
      parseExtensionInboundMessage({ kind: "ui.start", mode: "turbo", tabId: 42 }, popup)
    ).toBeNull();
    expect(
      parseExtensionInboundMessage({ kind: "ui.stop", tabId: Number.POSITIVE_INFINITY }, popup)
    ).toBeNull();
    expect(
      parseExtensionInboundMessage(
        {
          kind: "ui.export",
          sid: "session-1",
          policy: { maxArchiveBytes: Number.NaN }
        },
        popup
      )
    ).toBeNull();
    expect(
      parseExtensionInboundMessage(
        {
          kind: "ui.annotate",
          sid: "session-1",
          tags: Array.from({ length: 13 }, (_, index) => `tag-${index}`)
        },
        sessions
      )
    ).toBeNull();
    expect(
      parseExtensionInboundMessage({ kind: "ui.request-session-list", unexpected: "field" }, popup)
    ).toBeNull();
  });

  it("accepts a valid bounded RawRecorderEvent batch", () => {
    expect(
      parseExtensionInboundMessage(
        contentBatch([
          validRawEvent(),
          validRawEvent({
            rawType: "networkBody",
            t: 1_720_000_000_001,
            mono: 124,
            frame: "content-frame-2",
            payload: {
              reqId: "req-1",
              mime: "application/json",
              body: '{"ok":true}',
              nested: [null, true, undefined, 2]
            }
          })
        ]),
        portContext(PORT_NAMES.content, CONTENT_SENDER)
      )
    ).toEqual(
      contentBatch([
        validRawEvent(),
        validRawEvent({
          rawType: "networkBody",
          t: 1_720_000_000_001,
          mono: 124,
          frame: "content-frame-2",
          payload: {
            reqId: "req-1",
            mime: "application/json",
            body: '{"ok":true}',
            nested: [null, true, undefined, 2]
          }
        })
      ])
    );
  });

  it("strictly parses stop-drain tokens and acknowledgements", () => {
    const context = portContext(PORT_NAMES.content, CONTENT_SENDER);
    const stopBatch = {
      ...contentBatch([
        validRawEvent({
          rawType: "snapshot",
          sid: "S-stop-drain",
          payload: { reason: "stop", html: "<main>done</main>" }
        })
      ]),
      stopDrainToken: STOP_DRAIN_TOKEN
    };
    const acknowledgement = {
      kind: "content.stop-drained",
      activationId: ACTIVATION_ID,
      sid: "S-stop-drain",
      token: STOP_DRAIN_TOKEN,
      documentUrl: CONTENT_SENDER.url,
      expectedArtifacts: [],
      emittedArtifacts: [],
      omittedArtifacts: [],
      degradationReasons: []
    };

    expect(parseExtensionInboundMessage(stopBatch, context)).toEqual(stopBatch);
    expect(parseExtensionInboundMessage(acknowledgement, context)).toEqual(acknowledgement);
    expect(
      parseExtensionInboundMessage(
        {
          ...acknowledgement,
          expectedArtifacts: ["screenshot", "main-world-tail"],
          omittedArtifacts: ["screenshot", "main-world-tail"],
          degradationReasons: ["artifact-error"]
        },
        context
      )
    ).not.toBeNull();
    expect(
      parseExtensionInboundMessage(
        {
          ...acknowledgement,
          expectedArtifacts: ["screenshot"],
          omittedArtifacts: ["screenshot", "screenshot"]
        },
        context
      )
    ).toBeNull();
    expect(
      parseExtensionInboundMessage(
        {
          ...acknowledgement,
          expectedArtifacts: ["dom-secret"],
          omittedArtifacts: ["dom-secret"]
        },
        context
      )
    ).toBeNull();
    expect(parseExtensionInboundMessage({ ...acknowledgement, token: "" }, context)).toBeNull();
    expect(
      parseExtensionInboundMessage({ ...acknowledgement, token: "a".repeat(63) }, context)
    ).toBeNull();
    expect(
      parseExtensionInboundMessage({ ...acknowledgement, token: `${"a".repeat(63)}G` }, context)
    ).toBeNull();
    expect(
      parseExtensionInboundMessage({ ...stopBatch, stopDrainToken: "short" }, context)
    ).toBeNull();
    expect(
      parseExtensionInboundMessage({ ...acknowledgement, documentUrl: "not a url" }, context)
    ).toBeNull();
    expect(parseExtensionInboundMessage({ ...acknowledgement, replay: true }, context)).toBeNull();
  });

  it("enforces the sender-aligned content batch limit", () => {
    const context = portContext(PORT_NAMES.content, CONTENT_SENDER);
    const maximumBatch = Array.from({ length: CONTENT_EVENT_BATCH_MAX }, (_, index) =>
      validRawEvent({ mono: index })
    );
    const oversizedBatch = [...maximumBatch, validRawEvent({ mono: CONTENT_EVENT_BATCH_MAX })];

    expect(parseExtensionInboundMessage(contentBatch(maximumBatch), context)).not.toBeNull();
    expect(
      parseExtensionInboundMessage(
        { ...contentBatch(maximumBatch), batchId: `b1_${"D".repeat(64)}` },
        context
      )
    ).toBeNull();
    expect(parseExtensionInboundMessage(contentBatch(oversizedBatch), context)).toBeNull();
    expect(parseExtensionInboundMessage(contentBatch([]), context)).toBeNull();
  });

  it("rejects malformed, spoofed, and non-finite raw events", () => {
    const context = portContext(PORT_NAMES.content, CONTENT_SENDER);

    for (const event of [
      validRawEvent({ source: "system" }),
      validRawEvent({ rawType: "session-start" }),
      validRawEvent({ tabId: -1 }),
      validRawEvent({ sid: "" }),
      validRawEvent({ t: Number.NaN }),
      validRawEvent({ mono: Number.POSITIVE_INFINITY }),
      validRawEvent({ payload: new Date() }),
      validRawEvent({ cdpSessionId: "forged-cdp-session" })
    ]) {
      expect(parseExtensionInboundMessage(contentBatch([event]), context)).toBeNull();
    }
  });

  it("rejects cyclic, accessor-backed, and excessively deep payload graphs", () => {
    const context = portContext(PORT_NAMES.content, CONTENT_SENDER);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 24; index += 1) {
      deep = { child: deep };
    }

    const accessorPayload = {};
    Object.defineProperty(accessorPayload, "secret", {
      enumerable: true,
      get: () => "should-not-run"
    });

    expect(
      parseExtensionInboundMessage(contentBatch([validRawEvent({ payload: cyclic })]), context)
    ).toBeNull();
    expect(
      parseExtensionInboundMessage(contentBatch([validRawEvent({ payload: deep })]), context)
    ).toBeNull();
    expect(
      parseExtensionInboundMessage(
        contentBatch([validRawEvent({ payload: accessorPayload })]),
        context
      )
    ).toBeNull();
  });

  it("fails closed on malformed envelopes and document URLs", () => {
    const context = portContext(PORT_NAMES.content, CONTENT_SENDER);
    const getterMessage = {};
    Object.defineProperty(getterMessage, "kind", {
      enumerable: true,
      get: () => "content.ready"
    });

    expect(parseExtensionInboundMessage(null, context)).toBeNull();
    expect(parseExtensionInboundMessage(["content.ready"], context)).toBeNull();
    expect(parseExtensionInboundMessage(getterMessage, context)).toBeNull();
    expect(
      parseExtensionInboundMessage(
        {
          kind: "content.ready",
          readyId: READY_ID,
          reason: "requested",
          documentUrl: "not a url"
        },
        context
      )
    ).toBeNull();
    expect(
      parseExtensionInboundMessage(
        {
          kind: "content.bind",
          activationId: `a1_${"A".repeat(64)}`,
          documentUrl: CONTENT_SENDER.url
        },
        context
      )
    ).toBeNull();
  });
});
