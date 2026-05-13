// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const POPUP_EXPORT_POLICY_STORAGE_KEY = "webblackbox.popup.export-policy";
const EXPORT_PRIVACY_WARNING = {
  findingCount: 2,
  summary: "email in event:E-1, jwt in event:E-2",
  findings: [
    {
      kind: "email",
      path: "event:E-1",
      matchCount: 1
    },
    {
      kind: "jwt",
      path: "event:E-2",
      matchCount: 1
    }
  ]
};

type PortMessageHandler = (message: unknown) => void;

class FakePort {
  name = "webblackbox:popup";
  readonly postMessage = vi.fn();
  private readonly messageHandlers = new Set<PortMessageHandler>();

  readonly onMessage = {
    addListener: (handler: PortMessageHandler): void => {
      this.messageHandlers.add(handler);
    },
    removeListener: (handler: PortMessageHandler): void => {
      this.messageHandlers.delete(handler);
    }
  };

  readonly onDisconnect = {
    addListener: (): void => {
      void 0;
    },
    removeListener: (): void => {
      void 0;
    }
  };

  emit(message: unknown): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }
}

function installChromeStub(
  port: FakePort,
  options: {
    sendMessage?: ReturnType<typeof vi.fn>;
  } = {}
): void {
  const query = vi.fn(async () => [
    {
      id: 17,
      active: true,
      url: "https://example.com",
      lastAccessed: Date.now()
    }
  ]);
  const create = vi.fn(async (details: { url?: string; active?: boolean }) => ({
    id: 99,
    active: details.active ?? true,
    url: details.url
  }));
  const getURL = vi.fn((path: string) => `chrome-extension://test-extension/${path}`);

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    writable: true,
    value: {
      runtime: {
        connect: vi.fn(() => port),
        getURL,
        getManifest: vi.fn(() => ({
          version: "0.1.1"
        })),
        ...(options.sendMessage ? { sendMessage: options.sendMessage } : {})
      },
      tabs: {
        create,
        query
      }
    }
  });
}

async function flushPopup(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushPopupWithFakeTimers(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
}

function getCheckbox(): HTMLInputElement {
  const checkbox = document.querySelector<HTMLInputElement>("#export-include-screenshots");

  if (!checkbox) {
    throw new Error("missing screenshots checkbox");
  }

  return checkbox;
}

function getSensitiveAlertCheckbox(): HTMLInputElement {
  const checkbox = document.querySelector<HTMLInputElement>("#export-alert-sensitive-findings");

  if (!checkbox) {
    throw new Error("missing sensitive alert checkbox");
  }

  return checkbox;
}

function getMaxArchiveInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>("#export-max-size-mb");

  if (!input) {
    throw new Error("missing max archive input");
  }

  return input;
}

function getRecentMinutesInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>("#export-recent-minutes");

  if (!input) {
    throw new Error("missing recent minutes input");
  }

  return input;
}

function getExportButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>("[data-action='export']");

  if (!button) {
    throw new Error("missing export button");
  }

  return button;
}

function getStatusLine(): HTMLElement {
  const status = document.querySelector<HTMLElement>(".wb-popup__status");

  if (!status) {
    throw new Error("missing status line");
  }

  return status;
}

function getStartLiteButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>("[data-action='start-lite']");

  if (!button) {
    throw new Error("missing start lite button");
  }

  return button;
}

function getStartFullButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>("[data-action='start-full']");

  if (!button) {
    throw new Error("missing start full button");
  }

  return button;
}

function getSessionsButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>("[data-action='open-sessions']");

  if (!button) {
    throw new Error("missing sessions button");
  }

  return button;
}

function getOptionsButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>("[data-action='open-options']");

  if (!button) {
    throw new Error("missing options button");
  }

  return button;
}

function getPassphraseSubmitButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>("[data-passphrase-submit]");

  if (!button) {
    throw new Error("missing passphrase submit button");
  }

  return button;
}

async function importPopupModule(): Promise<void> {
  vi.resetModules();
  await import("./index.js");
  await flushPopup();
}

async function importPopupModuleWithFakeTimers(): Promise<void> {
  vi.resetModules();
  await import("./index.js");
  await flushPopupWithFakeTimers();
}

describe("popup export policy form", () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="popup-root"></main>`;
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, "chrome");
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("preserves the screenshots toggle and numeric draft fields across popup rerenders", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    const checkbox = getCheckbox();
    const sensitiveAlert = getSensitiveAlertCheckbox();
    const maxArchiveMb = getMaxArchiveInput();
    const recentMinutes = getRecentMinutesInput();

    expect(checkbox.checked).toBe(false);
    expect(sensitiveAlert.checked).toBe(true);
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    maxArchiveMb.value = "256";
    maxArchiveMb.dispatchEvent(new Event("input", { bubbles: true }));

    recentMinutes.value = "45";
    recentMinutes.dispatchEvent(new Event("input", { bubbles: true }));

    sensitiveAlert.checked = false;
    sensitiveAlert.dispatchEvent(new Event("change", { bubbles: true }));

    port.emit({
      kind: "sw.session-list",
      sessions: []
    });
    await flushPopup();

    expect(getCheckbox().checked).toBe(true);
    expect(getSensitiveAlertCheckbox().checked).toBe(false);
    expect(getMaxArchiveInput().value).toBe("256");
    expect(getRecentMinutesInput().value).toBe("45");
    expect(JSON.parse(localStorage.getItem(POPUP_EXPORT_POLICY_STORAGE_KEY) ?? "null")).toEqual({
      includeScreenshots: true,
      alertSensitiveFindings: false,
      maxArchiveMb: "256",
      recentMinutes: "45"
    });
  });

  it("exports the updated draft policy instead of the stale default values", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-1",
          tabId: 17,
          mode: "full",
          startedAt: Date.now(),
          active: false
        }
      ]
    });
    await flushPopup();

    const checkbox = getCheckbox();
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    const maxArchiveMb = getMaxArchiveInput();
    maxArchiveMb.value = "256";
    maxArchiveMb.dispatchEvent(new Event("input", { bubbles: true }));

    const recentMinutes = getRecentMinutesInput();
    recentMinutes.value = "45";
    recentMinutes.dispatchEvent(new Event("input", { bubbles: true }));

    getExportButton().click();
    await flushPopup();

    const promptForm = document.querySelector<HTMLFormElement>("form.wb-prompt-card");

    if (!promptForm) {
      throw new Error("missing export prompt");
    }

    const passphraseInput = document.querySelector<HTMLInputElement>("#wb-passphrase-input");

    if (!passphraseInput) {
      throw new Error("missing passphrase input");
    }

    passphraseInput.value = " export-secret ";
    passphraseInput.dispatchEvent(new Event("input", { bubbles: true }));
    getPassphraseSubmitButton().click();
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.export",
      sid: "sid-1",
      passphrase: " export-secret ",
      saveAs: false,
      policy: {
        includeScreenshots: false,
        maxArchiveBytes: 256 * 1024 * 1024,
        recentWindowMs: 45 * 60 * 1000
      }
    });
  });

  it("shows export progress and uses runtime acknowledgement when available", async () => {
    const port = new FakePort();
    let resolveExport: (value: unknown) => void = () => undefined;
    const sendMessage = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveExport = resolve;
        })
    );
    installChromeStub(port, { sendMessage });

    await importPopupModule();

    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-export-runtime",
          tabId: 17,
          mode: "full",
          startedAt: Date.now(),
          active: false
        }
      ]
    });
    await flushPopup();

    getExportButton().click();
    await flushPopup();

    const promptForm = document.querySelector<HTMLFormElement>("form.wb-prompt-card");
    const passphraseInput = document.querySelector<HTMLInputElement>("#wb-passphrase-input");

    if (!promptForm || !passphraseInput) {
      throw new Error("missing export prompt");
    }

    passphraseInput.value = "export-secret";
    passphraseInput.dispatchEvent(new Event("input", { bubbles: true }));
    getPassphraseSubmitButton().click();
    await flushPopup();

    expect(getStatusLine().textContent).toBe("Exporting...");
    expect(getExportButton().disabled).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ui.export",
        sid: "sid-export-runtime",
        passphrase: "export-secret",
        saveAs: false
      })
    );

    resolveExport({
      ok: true,
      fileName: "sid-export-runtime.webblackbox"
    });
    await flushPopup();

    expect(getStatusLine().textContent).toBe("Exported: sid-export-runtime.webblackbox");
    expect(getExportButton().disabled).toBe(false);
  });

  it("alerts and keeps the download success visible when export privacy findings are present", async () => {
    const port = new FakePort();
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const sendMessage = vi.fn(async () => ({
      ok: true,
      fileName: "sid-export-warning.webblackbox",
      privacyWarning: EXPORT_PRIVACY_WARNING
    }));
    installChromeStub(port, { sendMessage });

    await importPopupModule();

    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-export-warning",
          tabId: 17,
          mode: "full",
          startedAt: Date.now(),
          active: false
        }
      ]
    });
    await flushPopup();

    getExportButton().click();
    await flushPopup();

    const passphraseInput = document.querySelector<HTMLInputElement>("#wb-passphrase-input");

    if (!passphraseInput) {
      throw new Error("missing passphrase input");
    }

    passphraseInput.value = "export-secret";
    passphraseInput.dispatchEvent(new Event("input", { bubbles: true }));
    getPassphraseSubmitButton().click();
    await flushPopup();

    expect(getStatusLine().textContent).toBe("Exported: sid-export-warning.webblackbox");
    expect(alertSpy).toHaveBeenCalledWith(
      "Export completed, but the privacy scanner found 2 possible sensitive item(s): email in event:E-1, jwt in event:E-2. Review the archive before sharing."
    );
    expect(document.querySelector(".wb-popup__privacy-warning")?.textContent).toContain(
      "email in event:E-1, jwt in event:E-2"
    );

    port.emit({
      kind: "sw.export-status",
      sid: "sid-export-warning",
      ok: true,
      fileName: "sid-export-warning.webblackbox",
      privacyWarning: EXPORT_PRIVACY_WARNING
    });
    await flushPopup();

    expect(alertSpy).toHaveBeenCalledTimes(1);

    getExportButton().click();
    await flushPopup();

    const repeatPassphraseInput = document.querySelector<HTMLInputElement>("#wb-passphrase-input");

    if (!repeatPassphraseInput) {
      throw new Error("missing repeat passphrase input");
    }

    repeatPassphraseInput.value = "export-secret";
    repeatPassphraseInput.dispatchEvent(new Event("input", { bubbles: true }));
    getPassphraseSubmitButton().click();
    await flushPopup();

    expect(alertSpy).toHaveBeenCalledTimes(2);
  });

  it("suppresses popup privacy alerts when sensitive finding alerts are disabled", async () => {
    const port = new FakePort();
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const sendMessage = vi.fn(async () => ({
      ok: true,
      fileName: "sid-export-muted.webblackbox",
      privacyWarning: EXPORT_PRIVACY_WARNING
    }));
    installChromeStub(port, { sendMessage });

    await importPopupModule();

    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-export-muted",
          tabId: 17,
          mode: "full",
          startedAt: Date.now(),
          active: false
        }
      ]
    });
    await flushPopup();

    const sensitiveAlert = getSensitiveAlertCheckbox();
    sensitiveAlert.checked = false;
    sensitiveAlert.dispatchEvent(new Event("change", { bubbles: true }));
    await flushPopup();

    getExportButton().click();
    await flushPopup();

    const passphraseInput = document.querySelector<HTMLInputElement>("#wb-passphrase-input");

    if (!passphraseInput) {
      throw new Error("missing passphrase input");
    }

    passphraseInput.value = "export-secret";
    passphraseInput.dispatchEvent(new Event("input", { bubbles: true }));
    getPassphraseSubmitButton().click();
    await flushPopup();

    expect(getStatusLine().textContent).toBe("Exported: sid-export-muted.webblackbox");
    expect(alertSpy).not.toHaveBeenCalled();
    expect(document.querySelector(".wb-popup__privacy-warning")).toBeNull();
    expect(JSON.parse(localStorage.getItem(POPUP_EXPORT_POLICY_STORAGE_KEY) ?? "null")).toEqual(
      expect.objectContaining({
        alertSensitiveFindings: false
      })
    );
  });

  it("shows a retryable failure when the export acknowledgement stalls", async () => {
    vi.useFakeTimers();

    const port = new FakePort();
    const sendMessage = vi.fn(() => new Promise(() => undefined));
    installChromeStub(port, { sendMessage });

    await importPopupModuleWithFakeTimers();

    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-export-stalled",
          tabId: 17,
          mode: "full",
          startedAt: Date.now(),
          active: false
        }
      ]
    });
    await flushPopupWithFakeTimers();

    getExportButton().click();
    await flushPopupWithFakeTimers();

    const promptForm = document.querySelector<HTMLFormElement>("form.wb-prompt-card");
    const passphraseInput = document.querySelector<HTMLInputElement>("#wb-passphrase-input");

    if (!promptForm || !passphraseInput) {
      throw new Error("missing export prompt");
    }

    passphraseInput.value = "export-secret";
    passphraseInput.dispatchEvent(new Event("input", { bubbles: true }));
    getPassphraseSubmitButton().click();
    await flushPopupWithFakeTimers();

    expect(getStatusLine().textContent).toBe("Exporting...");
    expect(getExportButton().disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(120_000);
    await flushPopupWithFakeTimers();

    expect(getStatusLine().textContent).toBe(
      "Export failed: Export did not finish within 2 minutes. Check Chrome downloads or reload the extension and retry."
    );
    expect(getExportButton().disabled).toBe(false);
  });

  it("exports without encryption when the passphrase prompt is left empty", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-empty-passphrase",
          tabId: 17,
          mode: "lite",
          startedAt: Date.now(),
          active: false
        }
      ]
    });
    await flushPopup();

    getExportButton().click();
    await flushPopup();

    getPassphraseSubmitButton().click();
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.export",
      sid: "sid-empty-passphrase",
      saveAs: false,
      policy: {
        includeScreenshots: false,
        maxArchiveBytes: 100 * 1024 * 1024,
        recentWindowMs: 20 * 60 * 1000
      }
    });
  });

  it("opens the sessions and options pages from the popup", async () => {
    const port = new FakePort();
    installChromeStub(port);
    const windowClose = vi.spyOn(window, "close").mockImplementation(() => undefined);

    await importPopupModule();

    getSessionsButton().click();
    getOptionsButton().click();
    await flushPopup();

    const tabsCreate = (
      globalThis as typeof globalThis & {
        chrome?: {
          tabs?: {
            create?: ReturnType<typeof vi.fn>;
          };
        };
      }
    ).chrome?.tabs?.create;

    expect(tabsCreate).toHaveBeenNthCalledWith(1, {
      url: "chrome-extension://test-extension/sessions.html",
      active: true
    });
    expect(tabsCreate).toHaveBeenNthCalledWith(2, {
      url: "chrome-extension://test-extension/options.html",
      active: true
    });
    expect(windowClose).toHaveBeenCalledTimes(2);
  });

  it("disables start buttons only when the current tab is already recording", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-current",
          tabId: 17,
          mode: "lite",
          startedAt: Date.now(),
          active: true
        }
      ]
    });
    await flushPopup();

    expect(getStartLiteButton().disabled).toBe(true);
    expect(getStartFullButton().disabled).toBe(true);

    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-other",
          tabId: 42,
          mode: "full",
          startedAt: Date.now(),
          active: true
        }
      ]
    });
    await flushPopup();

    expect(getStartLiteButton().disabled).toBe(false);
    expect(getStartFullButton().disabled).toBe(false);
  });

  it("keeps start buttons disabled while a full start request is pending", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    getStartFullButton().click();
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.start",
      tabId: 17,
      mode: "full"
    });
    expect(getStartLiteButton().disabled).toBe(true);
    expect(getStartFullButton().disabled).toBe(true);

    port.emit({
      kind: "sw.session-list",
      sessions: []
    });
    await flushPopup();

    expect(getStartLiteButton().disabled).toBe(true);
    expect(getStartFullButton().disabled).toBe(true);

    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-started",
          tabId: 17,
          mode: "full",
          startedAt: Date.now(),
          active: true
        }
      ]
    });
    await flushPopup();
  });

  it("renders the ring buffer meter without inline styles", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-current",
          tabId: 17,
          mode: "lite",
          startedAt: Date.now() - 3 * 60 * 1000,
          ringBufferMinutes: 10,
          active: true
        }
      ]
    });
    await flushPopup();

    const meter = document.querySelector<HTMLProgressElement>("progress.wb-popup__buffer-meter");

    expect(meter).not.toBeNull();
    expect(meter?.value).toBeGreaterThan(0);
    expect(document.querySelector("[style]")).toBeNull();
  });
});
