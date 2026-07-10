import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import {
  deleteSessionFromSessionsPort,
  exportSessionFromPopupRuntime,
  startSessionFromPopupRuntime,
  stopSessionFromPopupPort
} from "../apps/extension/scripts/lib/extension-e2e-controller.mjs";

const extensionBaseUrl = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";

test("popup runtime helper starts and exports through authorized runtime messages", async () => {
  const messages = [];
  const client = createEvaluationClient({
    page: "popup.html",
    messages,
    tabs: [{ id: 42, url: "http://127.0.0.1/demo/", active: true }]
  });

  const started = await startSessionFromPopupRuntime(client, {
    mode: "full",
    expectedUrl: "http://127.0.0.1/demo/",
    visualCapture: "screenshots"
  });
  const exported = await exportSessionFromPopupRuntime(client, {
    sid: "session-1",
    passphrase: "secret",
    policy: { includeScreenshots: true }
  });

  assert.equal(started.ok, true);
  assert.equal(started.via, "popup-runtime");
  assert.equal(exported.ok, true);
  assert.deepEqual(messages, [
    {
      kind: "ui.start",
      tabId: 42,
      mode: "full",
      visualCapture: "screenshots"
    },
    {
      kind: "ui.export",
      sid: "session-1",
      passphrase: "secret",
      saveAs: false,
      policy: { includeScreenshots: true }
    }
  ]);
});

test("popup runtime helper rejects ambiguous tabs and missing acknowledgements", async () => {
  const wrongTabClient = createEvaluationClient({
    page: "popup.html",
    tabs: [{ id: 7, url: "http://127.0.0.1/unrelated/", active: true }]
  });
  const missingTarget = await startSessionFromPopupRuntime(wrongTabClient, {
    mode: "lite",
    expectedUrl: "http://127.0.0.1/demo/"
  });

  assert.equal(missingTarget.ok, false);
  assert.equal(missingTarget.reason, "target-tab-not-found");

  const unacknowledgedClient = createEvaluationClient({
    page: "popup.html",
    runtimeResponses: [undefined, {}],
    tabs: [{ id: 42, url: "http://127.0.0.1/demo/", active: true }]
  });
  const unacknowledgedStart = await startSessionFromPopupRuntime(unacknowledgedClient, {
    mode: "lite",
    expectedUrl: "http://127.0.0.1/demo/"
  });
  const unacknowledgedExport = await exportSessionFromPopupRuntime(unacknowledgedClient, {
    sid: "session-1",
    passphrase: "secret"
  });

  assert.equal(unacknowledgedStart.ok, false);
  assert.equal(unacknowledgedStart.reason, "runtime-start-rejected");
  assert.equal(unacknowledgedExport.ok, false);
  assert.equal(unacknowledgedExport.reason, "runtime-export-rejected");
});

test("popup stop helper uses the popup port instead of runtime messaging", async () => {
  const messages = [];
  const ports = [];
  const client = createEvaluationClient({ page: "popup.html", messages, ports });

  const stopped = await stopSessionFromPopupPort(client, { sid: "session-1", tabId: 42 });

  assert.deepEqual(stopped, {
    ok: true,
    sid: "session-1",
    tabId: 42,
    via: "popup-port"
  });
  assert.deepEqual(messages, []);
  assert.deepEqual(ports, [
    {
      name: "webblackbox:popup",
      messages: [{ kind: "ui.stop", tabId: 42 }],
      disconnected: true
    }
  ]);
});

test("session deletion requires sessions.html and the sessions port", async () => {
  const popupPorts = [];
  const popupClient = createEvaluationClient({ page: "popup.html", ports: popupPorts });
  const rejected = await deleteSessionFromSessionsPort(popupClient, { sid: "session-1" });

  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "unexpected-controller-page");
  assert.deepEqual(popupPorts, []);

  const sessionsPorts = [];
  const sessionsClient = createEvaluationClient({ page: "sessions.html", ports: sessionsPorts });
  const deleted = await deleteSessionFromSessionsPort(sessionsClient, { sid: "session-1" });

  assert.deepEqual(deleted, { ok: true, sid: "session-1", via: "sessions-port" });
  assert.deepEqual(sessionsPorts, [
    {
      name: "webblackbox:sessions",
      messages: [{ kind: "ui.delete", sid: "session-1" }],
      disconnected: true
    }
  ]);
});

function createEvaluationClient({
  page,
  messages = [],
  ports = [],
  runtimeResponses = [],
  tabs = []
}) {
  const location = { href: new URL(page, extensionBaseUrl).href };
  let runtimeResponseIndex = 0;
  const chrome = {
    runtime: {
      connect({ name }) {
        const record = { name, messages: [], disconnected: false };
        const listeners = new Set();
        ports.push(record);
        return {
          disconnect() {
            record.disconnected = true;
          },
          onMessage: {
            addListener(listener) {
              listeners.add(listener);
            },
            removeListener(listener) {
              listeners.delete(listener);
            }
          },
          postMessage(message) {
            const cloned = structuredClone(message);
            record.messages.push(cloned);
            const sessions =
              cloned.kind === "ui.stop"
                ? [{ sid: "session-1", active: false }]
                : cloned.kind === "ui.delete"
                  ? []
                  : [{ sid: "session-1", active: true }];
            queueMicrotask(() => {
              for (const listener of listeners) {
                listener({ kind: "sw.session-list", sessions });
              }
            });
          }
        };
      },
      getURL(path) {
        return new URL(path, extensionBaseUrl).href;
      },
      async sendMessage(message) {
        messages.push(structuredClone(message));

        if (runtimeResponseIndex < runtimeResponses.length) {
          const response = runtimeResponses[runtimeResponseIndex];
          runtimeResponseIndex += 1;
          return response;
        }

        return { ok: true };
      }
    },
    tabs: {
      async query() {
        return tabs;
      }
    }
  };

  return {
    async evaluate(expression) {
      return structuredClone(
        await vm.runInNewContext(expression, {
          chrome,
          clearTimeout,
          location,
          Promise,
          queueMicrotask,
          setTimeout
        })
      );
    }
  };
}
