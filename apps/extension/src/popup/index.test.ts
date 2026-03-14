// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const POPUP_EXPORT_POLICY_STORAGE_KEY = "webblackbox.popup.export-policy";

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

function installChromeStub(port: FakePort): void {
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
        }))
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

function getCheckbox(): HTMLInputElement {
  const checkbox = document.querySelector<HTMLInputElement>("#export-include-screenshots");

  if (!checkbox) {
    throw new Error("missing screenshots checkbox");
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

async function importPopupModule(): Promise<void> {
  vi.resetModules();
  await import("./index.js");
  await flushPopup();
}

describe("popup export policy form", () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="popup-root"></main>`;
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "chrome");
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("preserves the screenshots toggle and numeric draft fields across popup rerenders", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    const checkbox = getCheckbox();
    const maxArchiveMb = getMaxArchiveInput();
    const recentMinutes = getRecentMinutesInput();

    expect(checkbox.checked).toBe(true);
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    maxArchiveMb.value = "256";
    maxArchiveMb.dispatchEvent(new Event("input", { bubbles: true }));

    recentMinutes.value = "45";
    recentMinutes.dispatchEvent(new Event("input", { bubbles: true }));

    port.emit({
      kind: "sw.session-list",
      sessions: []
    });
    await flushPopup();

    expect(getCheckbox().checked).toBe(false);
    expect(getMaxArchiveInput().value).toBe("256");
    expect(getRecentMinutesInput().value).toBe("45");
    expect(JSON.parse(localStorage.getItem(POPUP_EXPORT_POLICY_STORAGE_KEY) ?? "null")).toEqual({
      includeScreenshots: false,
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

    promptForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.export",
      sid: "sid-1",
      passphrase: undefined,
      policy: {
        includeScreenshots: false,
        maxArchiveBytes: 256 * 1024 * 1024,
        recentWindowMs: 45 * 60 * 1000
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
});
