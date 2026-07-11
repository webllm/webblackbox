import { describe, expect, it } from "vitest";

import {
  RUNTIME_START_CAPABILITY_ERRORS,
  assertRuntimeStartRequirements,
  resolveInstalledRuntimeCapabilities,
  resolveRuntimeCapabilities,
  type RuntimeCapabilities
} from "./runtime-capabilities.js";

const STORE_SAFE_MANIFEST = {
  permissions: [
    "activeTab",
    "alarms",
    "downloads",
    "offscreen",
    "scripting",
    "storage",
    "tabCapture",
    "webNavigation"
  ]
};

const DEV_MANIFEST = {
  permissions: [
    "alarms",
    "debugger",
    "downloads",
    "offscreen",
    "scripting",
    "storage",
    "tabCapture",
    "tabs",
    "webNavigation",
    "webRequest"
  ],
  host_permissions: ["<all_urls>"]
};

function createCompleteChromeApi() {
  return {
    scripting: {
      executeScript: async () => []
    },
    debugger: {
      attach: async () => undefined,
      detach: async () => undefined,
      sendCommand: async () => ({}),
      onEvent: createEvent(),
      onDetach: createEvent()
    },
    tabCapture: {
      getMediaStreamId: async () => "stream-id"
    },
    webRequest: {
      onBeforeRequest: createEvent(),
      onCompleted: createEvent(),
      onErrorOccurred: createEvent()
    }
  };
}

function createEvent() {
  return {
    addListener: () => undefined,
    removeListener: () => undefined
  };
}

describe("resolveRuntimeCapabilities", () => {
  it("keeps the current store-safe profile on Lite core without browser network or Full", () => {
    const capabilities = resolveRuntimeCapabilities({
      manifest: STORE_SAFE_MANIFEST,
      chromeApi: createCompleteChromeApi()
    });

    expect(capabilities).toEqual({
      pageInjection: true,
      browserNetwork: "none",
      cdp: false,
      tabCapture: true,
      fullMode: false,
      globalVisual: false
    });
    expect(Object.isFrozen(capabilities)).toBe(true);
  });

  it("enables every static capability for the complete dev profile and API surface", () => {
    expect(
      resolveRuntimeCapabilities({
        manifest: DEV_MANIFEST,
        chromeApi: createCompleteChromeApi()
      })
    ).toEqual({
      pageInjection: true,
      browserNetwork: "webRequest",
      cdp: true,
      tabCapture: true,
      fullMode: true,
      globalVisual: true
    });
  });

  it.each([
    ["scripting permission", "scripting", "pageInjection"],
    ["debugger permission", "debugger", "cdp"],
    ["tabCapture permission", "tabCapture", "tabCapture"],
    ["webRequest permission", "webRequest", "browserNetwork"]
  ] as const)("fails closed when the %s is missing", (_label, permission, capability) => {
    const manifest = {
      ...DEV_MANIFEST,
      permissions: DEV_MANIFEST.permissions.filter((entry) => entry !== permission)
    };

    const resolved = resolveRuntimeCapabilities({ manifest, chromeApi: createCompleteChromeApi() });

    expect(resolved[capability]).toBe(capability === "browserNetwork" ? "none" : false);
  });

  it("requires either activeTab or broad host access for page injection", () => {
    const manifest = {
      permissions: DEV_MANIFEST.permissions.filter((entry) => entry !== "debugger")
    };

    expect(
      resolveRuntimeCapabilities({ manifest, chromeApi: createCompleteChromeApi() }).pageInjection
    ).toBe(false);
  });

  it("requires the activeTab permission for store-safe page injection", () => {
    const manifest = {
      permissions: STORE_SAFE_MANIFEST.permissions.filter((entry) => entry !== "activeTab")
    };

    expect(
      resolveRuntimeCapabilities({ manifest, chromeApi: createCompleteChromeApi() }).pageInjection
    ).toBe(false);
  });

  it("requires broad host access for browser-side webRequest capture", () => {
    const manifest = { permissions: DEV_MANIFEST.permissions };

    expect(
      resolveRuntimeCapabilities({ manifest, chromeApi: createCompleteChromeApi() }).browserNetwork
    ).toBe("none");
  });

  it.each([
    ["scripting.executeScript", ["scripting", "executeScript"], "pageInjection"],
    ["debugger.attach", ["debugger", "attach"], "cdp"],
    ["debugger.detach", ["debugger", "detach"], "cdp"],
    ["debugger.sendCommand", ["debugger", "sendCommand"], "cdp"],
    ["debugger.onEvent.addListener", ["debugger", "onEvent", "addListener"], "cdp"],
    ["debugger.onEvent.removeListener", ["debugger", "onEvent", "removeListener"], "cdp"],
    ["debugger.onDetach.addListener", ["debugger", "onDetach", "addListener"], "cdp"],
    ["debugger.onDetach.removeListener", ["debugger", "onDetach", "removeListener"], "cdp"],
    ["tabCapture.getMediaStreamId", ["tabCapture", "getMediaStreamId"], "tabCapture"],
    [
      "webRequest.onBeforeRequest.addListener",
      ["webRequest", "onBeforeRequest", "addListener"],
      "browserNetwork"
    ],
    [
      "webRequest.onBeforeRequest.removeListener",
      ["webRequest", "onBeforeRequest", "removeListener"],
      "browserNetwork"
    ],
    [
      "webRequest.onCompleted.addListener",
      ["webRequest", "onCompleted", "addListener"],
      "browserNetwork"
    ],
    [
      "webRequest.onCompleted.removeListener",
      ["webRequest", "onCompleted", "removeListener"],
      "browserNetwork"
    ],
    [
      "webRequest.onErrorOccurred.addListener",
      ["webRequest", "onErrorOccurred", "addListener"],
      "browserNetwork"
    ],
    [
      "webRequest.onErrorOccurred.removeListener",
      ["webRequest", "onErrorOccurred", "removeListener"],
      "browserNetwork"
    ]
  ] as const)("fails closed when API method %s is missing", (_label, path, capability) => {
    const chromeApi = createCompleteChromeApi() as Record<string, unknown>;
    deleteNestedProperty(chromeApi, path);

    const resolved = resolveRuntimeCapabilities({ manifest: DEV_MANIFEST, chromeApi });

    expect(resolved[capability]).toBe(capability === "browserNetwork" ? "none" : false);
  });

  it("does not let undeclared pseudo APIs grant capabilities", () => {
    const chromeApi = createCompleteChromeApi();

    expect(
      resolveRuntimeCapabilities({
        manifest: { permissions: [], host_permissions: [] },
        chromeApi: {
          ...chromeApi,
          pageInjection: true,
          cdp: true,
          fullMode: true,
          globalVisual: true,
          browserNetwork: "webRequest"
        }
      })
    ).toEqual({
      pageInjection: false,
      browserNetwork: "none",
      cdp: false,
      tabCapture: false,
      fullMode: false,
      globalVisual: false
    });
  });

  it.each([
    null,
    [],
    {},
    { permissions: "scripting" },
    { permissions: ["scripting", 1] },
    { permissions: ["scripting", "scripting"] },
    { permissions: [" scripting"] },
    { permissions: ["scripting"], host_permissions: "<all_urls>" },
    { permissions: ["scripting"], host_permissions: ["<all_urls>", "<all_urls>"] }
  ])("fails closed for malformed manifest input %#", (manifest) => {
    const capabilities = resolveRuntimeCapabilities({
      manifest,
      chromeApi: createCompleteChromeApi()
    });

    expect(capabilities).toEqual({
      pageInjection: false,
      browserNetwork: "none",
      cdp: false,
      tabCapture: false,
      fullMode: false,
      globalVisual: false
    });
  });

  it("fails closed when the API root is malformed", () => {
    expect(resolveRuntimeCapabilities({ manifest: DEV_MANIFEST, chromeApi: null })).toEqual({
      pageInjection: false,
      browserNetwork: "none",
      cdp: false,
      tabCapture: false,
      fullMode: false,
      globalVisual: false
    });
  });
});

describe("resolveInstalledRuntimeCapabilities", () => {
  it("reads the installed manifest through the runtime API", () => {
    const chromeApi = {
      ...createCompleteChromeApi(),
      runtime: {
        getManifest: () => DEV_MANIFEST
      }
    };

    expect(resolveInstalledRuntimeCapabilities(chromeApi)).toEqual({
      pageInjection: true,
      browserNetwork: "webRequest",
      cdp: true,
      tabCapture: true,
      fullMode: true,
      globalVisual: true
    });
  });

  it.each([
    {},
    { runtime: {} },
    {
      runtime: {
        getManifest: () => {
          throw new Error("manifest unavailable");
        }
      }
    }
  ])("fails closed when the installed manifest cannot be read %#", (chromeApi) => {
    expect(resolveInstalledRuntimeCapabilities(chromeApi)).toEqual({
      pageInjection: false,
      browserNetwork: "none",
      cdp: false,
      tabCapture: false,
      fullMode: false,
      globalVisual: false
    });
  });
});

describe("assertRuntimeStartRequirements", () => {
  const complete: RuntimeCapabilities = Object.freeze({
    pageInjection: true,
    browserNetwork: "webRequest",
    cdp: true,
    tabCapture: true,
    fullMode: true,
    globalVisual: true
  });

  it("accepts Lite, Full, and screen-recording starts when requirements are present", () => {
    expect(() =>
      assertRuntimeStartRequirements(complete, { mode: "lite", screenRecording: false })
    ).not.toThrow();
    expect(() =>
      assertRuntimeStartRequirements(complete, { mode: "full", screenRecording: false })
    ).not.toThrow();
    expect(() =>
      assertRuntimeStartRequirements(complete, { mode: "full", screenRecording: true })
    ).not.toThrow();
  });

  it("requires page injection for both modes", () => {
    const capabilities = { ...complete, pageInjection: false, fullMode: false };

    for (const mode of ["lite", "full"] as const) {
      expect(() =>
        assertRuntimeStartRequirements(capabilities, { mode, screenRecording: false })
      ).toThrow(RUNTIME_START_CAPABILITY_ERRORS.pageInjection);
    }
  });

  it("requires CDP for Full mode", () => {
    const capabilities = { ...complete, cdp: false, fullMode: false, globalVisual: false };

    expect(() =>
      assertRuntimeStartRequirements(capabilities, { mode: "full", screenRecording: false })
    ).toThrow(RUNTIME_START_CAPABILITY_ERRORS.fullCdp);
  });

  it("requires CDP and tabCapture for requested screen recording", () => {
    expect(() =>
      assertRuntimeStartRequirements(
        { ...complete, cdp: false, fullMode: false, globalVisual: false },
        { mode: "lite", screenRecording: true }
      )
    ).toThrow(RUNTIME_START_CAPABILITY_ERRORS.screenRecordingCdp);

    expect(() =>
      assertRuntimeStartRequirements(
        { ...complete, tabCapture: false },
        { mode: "full", screenRecording: true }
      )
    ).toThrow(RUNTIME_START_CAPABILITY_ERRORS.screenRecordingTabCapture);
  });

  it("rejects screen recording for the current store-safe capability set", () => {
    const capabilities = resolveRuntimeCapabilities({
      manifest: STORE_SAFE_MANIFEST,
      chromeApi: createCompleteChromeApi()
    });

    expect(() =>
      assertRuntimeStartRequirements(capabilities, { mode: "lite", screenRecording: true })
    ).toThrow(RUNTIME_START_CAPABILITY_ERRORS.screenRecordingCdp);
  });

  it("rejects unknown modes fail closed", () => {
    expect(() =>
      assertRuntimeStartRequirements(complete, {
        mode: "future" as "lite",
        screenRecording: false
      })
    ).toThrow(RUNTIME_START_CAPABILITY_ERRORS.unsupportedMode);
  });
});

function deleteNestedProperty(root: Record<string, unknown>, path: readonly string[]): void {
  let current = root;

  for (const segment of path.slice(0, -1)) {
    current = current[segment] as Record<string, unknown>;
  }

  delete current[path[path.length - 1]!];
}
