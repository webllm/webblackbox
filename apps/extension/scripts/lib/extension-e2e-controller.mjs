const POPUP_PAGE = "popup.html";
const POPUP_PORT = "webblackbox:popup";
const SESSIONS_PAGE = "sessions.html";
const SESSIONS_PORT = "webblackbox:sessions";

export async function startSessionFromPopupRuntime(
  popupClient,
  { mode, expectedUrl, reloadPage = false, visualCapture }
) {
  assertEvaluateClient(popupClient);

  if (mode !== "lite" && mode !== "full") {
    throw new TypeError(`Unsupported capture mode: ${String(mode)}`);
  }

  if (typeof expectedUrl !== "string" || expectedUrl.length === 0) {
    throw new TypeError("expectedUrl must be a non-empty string.");
  }

  return popupClient.evaluate(`
    (async () => {
      const expectedPage = chrome.runtime.getURL(${JSON.stringify(POPUP_PAGE)});

      if (location.href !== expectedPage) {
        return { ok: false, reason: 'unexpected-controller-page', expectedPage, actualPage: location.href };
      }

      const tabs = await chrome.tabs.query({});
      const exact = tabs.find((tab) =>
        typeof tab.id === 'number' &&
        typeof tab.url === 'string' &&
        tab.url.startsWith(${JSON.stringify(expectedUrl)})
      );

      if (!exact || typeof exact.id !== 'number') {
        return {
          ok: false,
          reason: 'target-tab-not-found',
          tabs: tabs.map((tab) => ({ id: tab.id, url: tab.url, active: tab.active }))
        };
      }

      const response = await chrome.runtime.sendMessage({
        kind: 'ui.start',
        tabId: exact.id,
        mode: ${JSON.stringify(mode)},
        ...(Boolean(${JSON.stringify(reloadPage)}) ? { reloadPage: true } : {}),
        ...(${JSON.stringify(visualCapture ?? null)} ? {
          visualCapture: ${JSON.stringify(visualCapture ?? null)}
        } : {})
      });

      if (response?.ok !== true) {
        return { ok: false, reason: 'runtime-start-rejected', tabId: exact.id, response };
      }

      return {
        ok: true,
        tabId: exact.id,
        mode: ${JSON.stringify(mode)},
        visualCapture: ${JSON.stringify(visualCapture ?? null)},
        via: 'popup-runtime'
      };
    })()
  `);
}

export async function exportSessionFromPopupRuntime(
  popupClient,
  { sid, passphrase, saveAs = false, policy }
) {
  assertEvaluateClient(popupClient);
  assertSessionId(sid);

  if (typeof passphrase !== "string") {
    throw new TypeError("passphrase must be a string.");
  }

  return popupClient.evaluate(`
    (async () => {
      const expectedPage = chrome.runtime.getURL(${JSON.stringify(POPUP_PAGE)});

      if (location.href !== expectedPage) {
        return { ok: false, reason: 'unexpected-controller-page', expectedPage, actualPage: location.href };
      }

      const response = await chrome.runtime.sendMessage({
        kind: 'ui.export',
        sid: ${JSON.stringify(sid)},
        passphrase: ${JSON.stringify(passphrase)},
        saveAs: ${JSON.stringify(saveAs)},
        ...(${JSON.stringify(policy ?? null)} ? { policy: ${JSON.stringify(policy ?? null)} } : {})
      });

      if (response?.ok !== true) {
        return { ok: false, reason: 'runtime-export-rejected', response };
      }

      return { ok: true, sid: ${JSON.stringify(sid)}, response, via: 'popup-runtime' };
    })()
  `);
}

export async function stopSessionFromPopupPort(popupClient, { sid, tabId }) {
  assertEvaluateClient(popupClient);
  assertSessionId(sid);
  assertTabId(tabId);

  return popupClient.evaluate(`
    (async () => {
      const expectedPage = chrome.runtime.getURL(${JSON.stringify(POPUP_PAGE)});

      if (location.href !== expectedPage) {
        return { ok: false, reason: 'unexpected-controller-page', expectedPage, actualPage: location.href };
      }

      const port = chrome.runtime.connect({ name: ${JSON.stringify(POPUP_PORT)} });
      const completion = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          port.onMessage.removeListener(onMessage);
          resolve({
            ok: false,
            reason: 'stop-session-list-timeout',
            sid: ${JSON.stringify(sid)},
            tabId: ${JSON.stringify(tabId)}
          });
        }, 30_000);
        const onMessage = (message) => {
          if (message?.kind !== 'sw.session-list' || !Array.isArray(message.sessions)) {
            return;
          }

          const session = message.sessions.find((row) => row?.sid === ${JSON.stringify(sid)});

          if (session?.active !== false && session !== undefined) {
            return;
          }

          clearTimeout(timeout);
          port.onMessage.removeListener(onMessage);
          resolve({
            ok: true,
            sid: ${JSON.stringify(sid)},
            tabId: ${JSON.stringify(tabId)},
            via: 'popup-port'
          });
        };

        port.onMessage.addListener(onMessage);
      });

      try {
        port.postMessage({ kind: 'ui.stop', tabId: ${JSON.stringify(tabId)} });
        return await completion;
      } finally {
        port.disconnect();
      }
    })()
  `);
}

export async function deleteSessionFromSessionsPort(sessionsClient, { sid }) {
  assertEvaluateClient(sessionsClient);
  assertSessionId(sid);

  return sessionsClient.evaluate(`
    (async () => {
      const expectedPage = chrome.runtime.getURL(${JSON.stringify(SESSIONS_PAGE)});

      if (location.href !== expectedPage) {
        return { ok: false, reason: 'unexpected-controller-page', expectedPage, actualPage: location.href };
      }

      const port = chrome.runtime.connect({ name: ${JSON.stringify(SESSIONS_PORT)} });
      const completion = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          port.onMessage.removeListener(onMessage);
          resolve({
            ok: false,
            reason: 'delete-session-list-timeout',
            sid: ${JSON.stringify(sid)}
          });
        }, 30_000);
        const onMessage = (message) => {
          if (message?.kind !== 'sw.session-list' || !Array.isArray(message.sessions)) {
            return;
          }

          if (message.sessions.some((row) => row?.sid === ${JSON.stringify(sid)})) {
            return;
          }

          clearTimeout(timeout);
          port.onMessage.removeListener(onMessage);
          resolve({ ok: true, sid: ${JSON.stringify(sid)}, via: 'sessions-port' });
        };

        port.onMessage.addListener(onMessage);
      });

      try {
        port.postMessage({ kind: 'ui.delete', sid: ${JSON.stringify(sid)} });
        return await completion;
      } finally {
        port.disconnect();
      }
    })()
  `);
}

function assertEvaluateClient(client) {
  if (!client || typeof client.evaluate !== "function") {
    throw new TypeError("A CDP client with evaluate() is required.");
  }
}

function assertSessionId(sid) {
  if (typeof sid !== "string" || sid.length === 0) {
    throw new TypeError("sid must be a non-empty string.");
  }
}

function assertTabId(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new TypeError("tabId must be a non-negative integer.");
  }
}
