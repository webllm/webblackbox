import type { CaptureMode } from "@webblackbox/protocol";

export type BrowserNetworkCapability = "none" | "webRequest";

export type RuntimeCapabilities = Readonly<{
  pageInjection: boolean;
  browserNetwork: BrowserNetworkCapability;
  cdp: boolean;
  tabCapture: boolean;
  fullMode: boolean;
  globalVisual: boolean;
}>;

export type RuntimeCapabilityInput = Readonly<{
  manifest: unknown;
  chromeApi: unknown;
}>;

export type RuntimeStartRequirements = Readonly<{
  mode: CaptureMode;
  screenRecording: boolean;
}>;

export const RUNTIME_START_CAPABILITY_ERRORS = Object.freeze({
  pageInjection: "Capture requires the page injection capability.",
  fullCdp: "Full capture requires the Chrome debugger capability.",
  screenRecordingCdp: "Screen recording requires the Chrome debugger capability.",
  screenRecordingTabCapture: "Screen recording requires the Chrome tabCapture capability.",
  unsupportedMode: "Unsupported capture mode."
} as const);

const NO_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  pageInjection: false,
  browserNetwork: "none",
  cdp: false,
  tabCapture: false,
  fullMode: false,
  globalVisual: false
});

/**
 * Resolves only static capabilities declared by the installed manifest and
 * exposed by the current Chrome runtime. The caller must pass the direct
 * result of `runtime.getManifest()` as `manifest`.
 *
 * `activeTab` makes page injection statically eligible, but does not prove a
 * grant for a particular tab. Callers must still require a successful,
 * strictly validated `scripting.executeScript()` result for that document.
 */
export function resolveRuntimeCapabilities({
  manifest,
  chromeApi
}: RuntimeCapabilityInput): RuntimeCapabilities {
  try {
    const declared = parseManifestCapabilities(manifest);
    const api = asRecord(chromeApi);

    if (!declared || !api) {
      return NO_RUNTIME_CAPABILITIES;
    }

    const hasBroadHostAccess = declared.hostPermissions.has("<all_urls>");
    const hasPageAccess = hasBroadHostAccess || declared.permissions.has("activeTab");
    const pageInjection =
      declared.permissions.has("scripting") &&
      hasPageAccess &&
      hasMethod(api.scripting, "executeScript");
    const hasBrowserNetwork =
      declared.permissions.has("webRequest") &&
      hasBroadHostAccess &&
      hasEvent(api.webRequest, "onBeforeRequest") &&
      hasEvent(api.webRequest, "onCompleted") &&
      hasEvent(api.webRequest, "onErrorOccurred");
    const cdp =
      declared.permissions.has("debugger") &&
      hasMethod(api.debugger, "attach") &&
      hasMethod(api.debugger, "detach") &&
      hasMethod(api.debugger, "sendCommand") &&
      hasEvent(api.debugger, "onEvent") &&
      hasEvent(api.debugger, "onDetach");
    const tabCapture =
      declared.permissions.has("tabCapture") && hasMethod(api.tabCapture, "getMediaStreamId");

    return Object.freeze({
      pageInjection,
      browserNetwork: hasBrowserNetwork ? "webRequest" : "none",
      cdp,
      tabCapture,
      fullMode: pageInjection && cdp,
      globalVisual: cdp
    });
  } catch {
    return NO_RUNTIME_CAPABILITIES;
  }
}

/** Resolves capabilities from the manifest installed in the current Chrome runtime. */
export function resolveInstalledRuntimeCapabilities(chromeApi: unknown): RuntimeCapabilities {
  try {
    const api = asRecord(chromeApi);
    const runtime = asRecord(api?.runtime);
    const getManifest = runtime?.getManifest;

    if (typeof getManifest !== "function") {
      return NO_RUNTIME_CAPABILITIES;
    }

    return resolveRuntimeCapabilities({
      manifest: getManifest.call(runtime),
      chromeApi
    });
  } catch {
    return NO_RUNTIME_CAPABILITIES;
  }
}

export function assertRuntimeStartRequirements(
  capabilities: RuntimeCapabilities,
  requirements: RuntimeStartRequirements
): void {
  if (requirements.mode !== "lite" && requirements.mode !== "full") {
    throw new Error(RUNTIME_START_CAPABILITY_ERRORS.unsupportedMode);
  }

  if (!capabilities.pageInjection) {
    throw new Error(RUNTIME_START_CAPABILITY_ERRORS.pageInjection);
  }

  if (requirements.mode === "full" && !capabilities.cdp) {
    throw new Error(RUNTIME_START_CAPABILITY_ERRORS.fullCdp);
  }

  if (requirements.screenRecording && !capabilities.cdp) {
    throw new Error(RUNTIME_START_CAPABILITY_ERRORS.screenRecordingCdp);
  }

  if (requirements.screenRecording && !capabilities.tabCapture) {
    throw new Error(RUNTIME_START_CAPABILITY_ERRORS.screenRecordingTabCapture);
  }
}

type ManifestCapabilities = Readonly<{
  permissions: ReadonlySet<string>;
  hostPermissions: ReadonlySet<string>;
}>;

function parseManifestCapabilities(value: unknown): ManifestCapabilities | undefined {
  const manifest = asRecord(value);

  if (!manifest) {
    return undefined;
  }

  const permissions = parseStringSet(manifest.permissions, true);
  const hostPermissions = parseStringSet(manifest.host_permissions, false);

  if (!permissions || !hostPermissions) {
    return undefined;
  }

  return { permissions, hostPermissions };
}

function parseStringSet(value: unknown, required: boolean): ReadonlySet<string> | undefined {
  if (value === undefined && !required) {
    return new Set();
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const result = new Set<string>();

  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.trim() !== entry ||
      result.has(entry)
    ) {
      return undefined;
    }

    result.add(entry);
  }

  return result;
}

function hasMethod(value: unknown, name: string): boolean {
  const record = asRecord(value);
  return typeof record?.[name] === "function";
}

function hasEvent(value: unknown, name: string): boolean {
  const record = asRecord(value);
  const event = asRecord(record?.[name]);
  return typeof event?.addListener === "function" && typeof event.removeListener === "function";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
