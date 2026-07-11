// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "webblackbox.options";

type StoragePayload = Record<string, unknown>;
type RuntimeFixture = "dev" | "store-safe" | "cdp-no-tab-capture";

function installChromeStub(
  initialValue: unknown,
  { runtimeFixture = "dev" }: { runtimeFixture?: RuntimeFixture } = {}
) {
  const hasCdp = runtimeFixture !== "store-safe";
  const hasTabCapture = runtimeFixture !== "cdp-no-tab-capture";
  const permissions = [
    runtimeFixture === "store-safe" ? "activeTab" : undefined,
    "scripting",
    hasCdp ? "debugger" : undefined,
    hasTabCapture ? "tabCapture" : undefined,
    runtimeFixture === "dev" ? "webRequest" : undefined
  ].filter((permission): permission is string => typeof permission === "string");
  const runtimeEvent = {
    addListener: vi.fn(),
    removeListener: vi.fn()
  };
  const get = vi.fn(async () => ({
    [STORAGE_KEY]: initialValue
  }));
  const set = vi.fn(async (value: StoragePayload) => value);

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    writable: true,
    value: {
      runtime: {
        getManifest: vi.fn(() => ({
          permissions,
          ...(runtimeFixture === "store-safe" ? {} : { host_permissions: ["<all_urls>"] })
        }))
      },
      scripting: {
        executeScript: vi.fn(async () => [])
      },
      ...(hasCdp
        ? {
            debugger: {
              attach: vi.fn(async () => undefined),
              detach: vi.fn(async () => undefined),
              sendCommand: vi.fn(async () => ({})),
              onEvent: runtimeEvent,
              onDetach: runtimeEvent
            }
          }
        : {}),
      ...(hasTabCapture
        ? {
            tabCapture: {
              getMediaStreamId: vi.fn(async () => "stream-id")
            }
          }
        : {}),
      ...(runtimeFixture === "dev"
        ? {
            webRequest: {
              onBeforeRequest: runtimeEvent,
              onCompleted: runtimeEvent,
              onErrorOccurred: runtimeEvent
            }
          }
        : {}),
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

  it("renders Lite and Full controls in a fully capable development runtime", async () => {
    installChromeStub(undefined, { runtimeFixture: "dev" });

    await importOptionsModule();

    const liteProfile = document.querySelector("[data-mode-profile='lite']");
    expect(liteProfile).not.toBeNull();
    expect(liteProfile?.textContent).toContain(
      "Page-side lightweight signals with browser-side network metadata."
    );
    expect(liteProfile?.textContent).toContain("browser-side network baseline");
    expect(document.querySelector("[data-mode-profile='full']")).not.toBeNull();
    expect(document.querySelector("#screenshotIdleMs")).not.toBeNull();
    expect(document.querySelector("#bodyCaptureMaxBytes")).not.toBeNull();
    expect(document.querySelector("#redactHeaders")).not.toBeNull();
    expect(document.querySelector("#budgetRequestWarnMs")).not.toBeNull();
    expect(document.querySelector("#budgetErrorRateWarnPct")).not.toBeNull();
  });

  it("renders Full/CDP controls even when tabCapture is unavailable", async () => {
    installChromeStub(undefined, { runtimeFixture: "cdp-no-tab-capture" });

    await importOptionsModule();

    expect(document.querySelector("[data-mode-profile='full']")).not.toBeNull();
    expect(document.querySelector("#screenshotIdleMs")).not.toBeNull();
    expect(document.querySelector("#bodyCaptureMaxBytes")).not.toBeNull();
    expect(document.querySelector("#redactHeaders")).not.toBeNull();
    expect(document.querySelector("#budgetRequestWarnMs")).not.toBeNull();
    expect(document.querySelector("#budgetErrorRateWarnPct")).not.toBeNull();
  });

  it("shows only Lite-relevant controls in a store-safe runtime", async () => {
    installChromeStub(undefined, { runtimeFixture: "store-safe" });

    await importOptionsModule();

    const liteProfile = document.querySelector("[data-mode-profile='lite']");
    expect(liteProfile).not.toBeNull();
    expect(liteProfile?.textContent).toContain(
      "This runtime provides no Chrome webRequest coverage."
    );
    expect(liteProfile?.textContent).toContain("mutation summary (page-side only)");
    expect(liteProfile?.textContent).not.toContain(
      "Page-side lightweight signals with browser-side network metadata."
    );
    expect(liteProfile?.textContent).not.toContain("browser-side network baseline");
    expect(document.querySelector("[data-mode-profile='full']")).toBeNull();
    expect(document.querySelector("#screenshotIdleMs")).toBeNull();
    expect(document.querySelector("#bodyCaptureMaxBytes")).toBeNull();
    expect(document.querySelector("#redactHeaders")).toBeNull();
    expect(document.querySelector("#budgetRequestWarnMs")).toBeNull();
    expect(document.querySelector("#budgetErrorRateWarnPct")).toBeNull();
    expect(document.querySelector("#snapshotIntervalMs")).not.toBeNull();
    expect(document.querySelector("#budgetLcpWarnMs")).not.toBeNull();
    expect(document.querySelector("#blockedSelectors")).not.toBeNull();
    expect(document.querySelector("#redactBodyPatterns")).not.toBeNull();
    expect(document.querySelector("#hashSensitiveValues")).not.toBeNull();
    expect(document.body.textContent).toContain(
      "Available capture profiles are shown according to the capabilities provided by this extension runtime."
    );
    expect(document.body.textContent).toContain(
      "Controls periodic summary-only DOM snapshots. It does not capture page images or schedule screenshots."
    );
  });

  it("preserves loaded values for hidden store-safe fields when saving", async () => {
    const { set } = installChromeStub(
      {
        optionsVersion: 1,
        sampling: {
          screenshotIdleMs: 8_765,
          bodyCaptureMaxBytes: 54_321
        },
        redaction: {
          redactHeaders: ["authorization", "x-private-header"]
        },
        performanceBudget: {
          lcpWarnMs: 2_700,
          requestWarnMs: 9_800,
          errorRateWarnPct: 42,
          autoFreezeOnBreach: true
        }
      },
      { runtimeFixture: "store-safe" }
    );

    await importOptionsModule();

    const snapshotInterval = document.querySelector<HTMLInputElement>("#snapshotIntervalMs");

    if (!snapshotInterval) {
      throw new Error("missing snapshot interval input");
    }

    snapshotInterval.value = "4321";
    document.querySelector<HTMLButtonElement>("#saveConfig")?.click();
    await flushOptions();

    expect(set).toHaveBeenCalledTimes(1);
    const saved = set.mock.calls[0]?.[0]?.[STORAGE_KEY] as {
      sampling: {
        snapshotIntervalMs: number;
        screenshotIdleMs: number;
        bodyCaptureMaxBytes: number;
      };
      redaction: { redactHeaders: string[] };
      performanceBudget: {
        lcpWarnMs: number;
        requestWarnMs: number;
        errorRateWarnPct: number;
        autoFreezeOnBreach: boolean;
      };
    };

    expect(saved.sampling).toMatchObject({
      snapshotIntervalMs: 4_321,
      screenshotIdleMs: 8_765,
      bodyCaptureMaxBytes: 54_321
    });
    expect(saved.redaction.redactHeaders).toEqual(["authorization", "x-private-header"]);
    expect(saved.performanceBudget).toEqual({
      lcpWarnMs: 2_700,
      requestWarnMs: 9_800,
      errorRateWarnPct: 42,
      autoFreezeOnBreach: true
    });
  });
});
