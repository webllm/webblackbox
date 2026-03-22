// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "webblackbox.options";

type StoragePayload = Record<string, unknown>;

function installChromeStub(initialValue: unknown) {
  const get = vi.fn(async () => ({
    [STORAGE_KEY]: initialValue
  }));
  const set = vi.fn(async (value: StoragePayload) => value);

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    writable: true,
    value: {
      storage: {
        local: {
          get,
          set
        }
      }
    }
  });

  return { get, set };
}

async function flushOptions(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function importOptionsModule(): Promise<void> {
  vi.resetModules();
  await import("./index.js");
  await flushOptions();
}

function getTextarea(id: string): HTMLTextAreaElement {
  const textarea = document.getElementById(id);

  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error(`missing textarea ${id}`);
  }

  return textarea;
}

describe("options page rendering", () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="options-root"></main>`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "chrome");
    document.body.innerHTML = "";
  });

  it("renders stored textarea content as plain text instead of DOM", async () => {
    const injectedValue = `</textarea><button id="pwned">x</button>`;
    installChromeStub({
      redaction: {
        blockedSelectors: [injectedValue],
        redactHeaders: [injectedValue],
        redactBodyPatterns: [injectedValue]
      }
    });

    await importOptionsModule();

    expect(getTextarea("blockedSelectors").value).toBe(injectedValue);
    expect(getTextarea("redactHeaders").value).toBe(injectedValue);
    expect(getTextarea("redactBodyPatterns").value).toBe(injectedValue);
    expect(document.getElementById("pwned")).toBeNull();
  });

  it("renders without inline style attributes", async () => {
    installChromeStub(undefined);

    await importOptionsModule();

    expect(document.querySelector("[style]")).toBeNull();
  });
});
