import type { RawRecorderEvent } from "@webblackbox/recorder";

import type { MessageSenderLike, PortLike } from "./chrome-api.js";
import {
  CONTENT_EVENT_BATCH_MAX,
  PORT_NAMES,
  type ContentEventBatchMessage,
  type ExtensionInboundMessage,
  type UiAnnotateSessionMessage,
  type UiExportSessionMessage,
  type UiStartSessionMessage
} from "./messages.js";
import { isStopDrainToken } from "./stop-drain-token.js";

export type ExtensionInboundContext =
  | {
      transport: "port";
      portName: string;
      sender?: MessageSenderLike;
      extensionBaseUrl: string;
    }
  | {
      transport: "runtime";
      sender?: MessageSenderLike;
      extensionBaseUrl: string;
    };

type InboundPrincipal = "content" | "offscreen" | "options" | "popup" | "sessions";

type PayloadBudget = {
  nodes: number;
  stringChars: number;
};

const UI_PAGE_BY_PRINCIPAL = {
  offscreen: "offscreen.html",
  options: "options.html",
  popup: "popup.html",
  sessions: "sessions.html"
} as const;

const CONTENT_RAW_TYPES = new Set([
  "blur",
  "click",
  "console",
  "cookieSnapshot",
  "dblclick",
  "fetch",
  "fetchError",
  "focus",
  "indexedDbOp",
  "indexedDbSnapshot",
  "input",
  "keydown",
  "localStorageOp",
  "localStorageSnapshot",
  "longtask",
  "marker",
  "mousemove",
  "mutation",
  "networkBody",
  "pageError",
  "privacyViolation",
  "resize",
  "resourceError",
  "rrweb",
  "screenshot",
  "scroll",
  "sessionStorageOp",
  "snapshot",
  "sse",
  "submit",
  "unhandledrejection",
  "visibilitychange",
  "vitals",
  "xhr"
]);

const MAX_DOCUMENT_URL_CHARS = 16 * 1024;
const MAX_IDENTIFIER_CHARS = 256;
const MAX_MARKER_CHARS = 512;
const MAX_PASSPHRASE_CHARS = 4 * 1024;
const MAX_PAYLOAD_DEPTH = 20;
const MAX_PAYLOAD_NODES = 100_000;
const MAX_PAYLOAD_OBJECT_KEYS = 2_048;
const MAX_PAYLOAD_STRING_CHARS = 12 * 1024 * 1024;
const MAX_BATCH_PAYLOAD_STRING_CHARS = 24 * 1024 * 1024;
const MAX_TAGS = 12;
const MAX_TAG_CHARS = 40;
const MAX_NOTE_CHARS = 500;
const MAX_EXPORT_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_EXPORT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const UI_START_KEYS = new Set([
  "kind",
  "mode",
  "recordScreen",
  "reloadPage",
  "tabId",
  "visualCapture"
]);
const UI_STOP_KEYS = new Set(["kind", "tabId"]);
const UI_EXPORT_KEYS = new Set(["kind", "passphrase", "policy", "saveAs", "sid"]);
const UI_DELETE_KEYS = new Set(["kind", "sid"]);
const UI_ANNOTATE_KEYS = new Set(["kind", "note", "sid", "tags"]);
const KIND_ONLY_KEYS = new Set(["kind"]);
const CONTENT_EVENTS_KEYS = new Set(["documentUrl", "events", "kind", "stopDrainToken"]);
const CONTENT_MARKER_KEYS = new Set(["documentUrl", "kind", "message"]);
const CONTENT_READY_KEYS = new Set(["documentUrl", "kind"]);
const CONTENT_STOP_DRAINED_KEYS = new Set(["documentUrl", "kind", "sid", "token"]);
const EXPORT_POLICY_KEYS = new Set([
  "includeScreenRecordings",
  "includeScreenshots",
  "maxArchiveBytes",
  "recentWindowMs"
]);
const RAW_EVENT_KEYS = new Set([
  "frame",
  "mono",
  "payload",
  "rawType",
  "sid",
  "source",
  "t",
  "tabId"
]);

/**
 * Verifies that a named runtime port really belongs to the extension surface
 * associated with that name. Content ports are instead bound to a concrete
 * tab/frame sender and cannot claim an extension UI principal.
 */
export function isAuthorizedExtensionPort(
  port: Pick<PortLike, "name" | "sender">,
  extensionBaseUrl: string
): boolean {
  try {
    return resolvePortPrincipal(port.name, port.sender, extensionBaseUrl) !== null;
  } catch {
    return false;
  }
}

/**
 * Parses untrusted Chrome runtime input into a fresh, bounded message envelope.
 * The source principal is authorized before payload traversal, then every
 * control message and RawRecorderEvent is validated without type assertions.
 */
export function parseExtensionInboundMessage(
  value: unknown,
  context: ExtensionInboundContext
): ExtensionInboundMessage | null {
  try {
    const principal = resolveInboundPrincipal(context);

    if (!principal) {
      return null;
    }

    const row = asPlainRecord(value);

    if (!row) {
      return null;
    }

    const kind = row.kind;

    if (typeof kind !== "string" || !isKindAllowed(principal, context.transport, kind)) {
      return null;
    }

    switch (kind) {
      case "ui.start":
        return parseUiStart(row);
      case "ui.stop":
        return parseUiStop(row);
      case "ui.export":
        return parseUiExport(row);
      case "ui.delete":
        return parseUiDelete(row);
      case "ui.annotate":
        return parseUiAnnotate(row);
      case "ui.request-session-list":
        return hasExactKeys(row, KIND_ONLY_KEYS) ? { kind } : null;
      case "content.events":
        return parseContentEvents(row);
      case "content.marker":
        return parseContentMarker(row);
      case "content.ready":
        return parseContentReady(row);
      case "content.stop-drained":
        return parseContentStopDrained(row);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function resolveInboundPrincipal(context: ExtensionInboundContext): InboundPrincipal | null {
  if (context.transport === "port") {
    return resolvePortPrincipal(context.portName, context.sender, context.extensionBaseUrl);
  }

  const uiPrincipal = resolveUiPrincipal(context.sender, context.extensionBaseUrl);

  if (uiPrincipal) {
    return uiPrincipal;
  }

  return isContentSender(context.sender, context.extensionBaseUrl) ? "content" : null;
}

function resolvePortPrincipal(
  portName: string,
  sender: MessageSenderLike | undefined,
  extensionBaseUrl: string
): InboundPrincipal | null {
  if (portName === PORT_NAMES.content) {
    return isContentSender(sender, extensionBaseUrl) ? "content" : null;
  }

  const uiPrincipal = resolveUiPrincipal(sender, extensionBaseUrl);

  if (portName === PORT_NAMES.popup && uiPrincipal === "popup") {
    return uiPrincipal;
  }

  if (portName === PORT_NAMES.sessions && uiPrincipal === "sessions") {
    return uiPrincipal;
  }

  if (portName === PORT_NAMES.options && uiPrincipal === "options") {
    return uiPrincipal;
  }

  if (portName === PORT_NAMES.offscreen && uiPrincipal === "offscreen") {
    return uiPrincipal;
  }

  return null;
}

function resolveUiPrincipal(
  sender: MessageSenderLike | undefined,
  extensionBaseUrl: string
): Exclude<InboundPrincipal, "content"> | null {
  if (typeof sender?.url !== "string") {
    return null;
  }

  for (const [principal, page] of Object.entries(UI_PAGE_BY_PRINCIPAL) as Array<
    [Exclude<InboundPrincipal, "content">, string]
  >) {
    if (isExactExtensionPage(sender.url, extensionBaseUrl, page)) {
      return principal;
    }
  }

  return null;
}

function isContentSender(sender: MessageSenderLike | undefined, extensionBaseUrl: string): boolean {
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId;
  const senderUrl = sender?.url;

  if (
    !Number.isSafeInteger(tabId) ||
    (tabId as number) < 0 ||
    (frameId !== undefined && (!Number.isSafeInteger(frameId) || frameId < 0)) ||
    typeof senderUrl !== "string" ||
    senderUrl.length === 0 ||
    senderUrl.length > MAX_DOCUMENT_URL_CHARS
  ) {
    return false;
  }

  const parsedSenderUrl = parseUrl(senderUrl);
  const parsedExtensionBase = parseUrl(extensionBaseUrl);

  if (!parsedSenderUrl || !parsedExtensionBase) {
    return false;
  }

  return !hasSameUrlAuthority(parsedSenderUrl, parsedExtensionBase);
}

function isExactExtensionPage(senderUrl: string, extensionBaseUrl: string, page: string): boolean {
  if (senderUrl.length === 0 || senderUrl.length > MAX_DOCUMENT_URL_CHARS) {
    return false;
  }

  const parsedSenderUrl = parseUrl(senderUrl);
  const expectedUrl = parseUrl(new URL(page, extensionBaseUrl).href);

  return Boolean(
    parsedSenderUrl &&
    expectedUrl &&
    parsedSenderUrl.protocol === expectedUrl.protocol &&
    parsedSenderUrl.host === expectedUrl.host &&
    parsedSenderUrl.pathname === expectedUrl.pathname &&
    parsedSenderUrl.search === "" &&
    parsedSenderUrl.hash === ""
  );
}

function hasSameUrlAuthority(left: URL, right: URL): boolean {
  return left.protocol === right.protocol && left.host === right.host;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isKindAllowed(
  principal: InboundPrincipal,
  transport: ExtensionInboundContext["transport"],
  kind: string
): boolean {
  if (principal === "content") {
    if (transport === "runtime") {
      return kind === "content.ready";
    }

    return (
      kind === "content.events" ||
      kind === "content.marker" ||
      kind === "content.ready" ||
      kind === "content.stop-drained"
    );
  }

  if (principal === "popup") {
    if (transport === "runtime") {
      return kind === "ui.start" || kind === "ui.export";
    }

    return (
      kind === "ui.start" ||
      kind === "ui.stop" ||
      kind === "ui.export" ||
      kind === "ui.request-session-list"
    );
  }

  if (principal === "sessions" && transport === "port") {
    return (
      kind === "ui.stop" || kind === "ui.export" || kind === "ui.delete" || kind === "ui.annotate"
    );
  }

  return false;
}

function parseUiStart(row: Record<string, unknown>): UiStartSessionMessage | null {
  if (!hasExactKeys(row, UI_START_KEYS)) {
    return null;
  }

  const tabId = parseOptionalTabId(row.tabId);
  const reloadPage = parseOptionalBoolean(row.reloadPage);
  const recordScreen = parseOptionalBoolean(row.recordScreen);
  const visualCapture = row.visualCapture;

  if (
    tabId === null ||
    reloadPage === null ||
    recordScreen === null ||
    (row.mode !== "lite" && row.mode !== "full") ||
    (visualCapture !== undefined &&
      visualCapture !== "screenshots" &&
      visualCapture !== "recording" &&
      visualCapture !== "both" &&
      visualCapture !== "none")
  ) {
    return null;
  }

  return {
    kind: "ui.start",
    mode: row.mode,
    ...(tabId === undefined ? {} : { tabId }),
    ...(reloadPage === undefined ? {} : { reloadPage }),
    ...(visualCapture === undefined ? {} : { visualCapture }),
    ...(recordScreen === undefined ? {} : { recordScreen })
  };
}

function parseUiStop(row: Record<string, unknown>): ExtensionInboundMessage | null {
  if (!hasExactKeys(row, UI_STOP_KEYS)) {
    return null;
  }

  const tabId = parseOptionalTabId(row.tabId);

  if (tabId === null) {
    return null;
  }

  return {
    kind: "ui.stop",
    ...(tabId === undefined ? {} : { tabId })
  };
}

function parseUiExport(row: Record<string, unknown>): UiExportSessionMessage | null {
  if (!hasExactKeys(row, UI_EXPORT_KEYS) || !isIdentifier(row.sid, false)) {
    return null;
  }

  const passphrase = parseOptionalBoundedString(row.passphrase, MAX_PASSPHRASE_CHARS);
  const saveAs = parseOptionalBoolean(row.saveAs);
  const policy = parseExportPolicy(row.policy);

  if (passphrase === null || saveAs === null || policy === null) {
    return null;
  }

  return {
    kind: "ui.export",
    sid: row.sid,
    ...(passphrase === undefined ? {} : { passphrase }),
    ...(saveAs === undefined ? {} : { saveAs }),
    ...(policy === undefined ? {} : { policy })
  };
}

function parseUiDelete(row: Record<string, unknown>): ExtensionInboundMessage | null {
  if (!hasExactKeys(row, UI_DELETE_KEYS) || !isIdentifier(row.sid, false)) {
    return null;
  }

  return {
    kind: "ui.delete",
    sid: row.sid
  };
}

function parseUiAnnotate(row: Record<string, unknown>): UiAnnotateSessionMessage | null {
  if (!hasExactKeys(row, UI_ANNOTATE_KEYS) || !isIdentifier(row.sid, false)) {
    return null;
  }

  const tags = parseOptionalTags(row.tags);
  const note = parseOptionalBoundedString(row.note, MAX_NOTE_CHARS);

  if (tags === null || note === null) {
    return null;
  }

  return {
    kind: "ui.annotate",
    sid: row.sid,
    ...(tags === undefined ? {} : { tags }),
    ...(note === undefined ? {} : { note })
  };
}

function parseContentEvents(row: Record<string, unknown>): ContentEventBatchMessage | null {
  if (!hasExactKeys(row, CONTENT_EVENTS_KEYS)) {
    return null;
  }

  const documentUrl = parseDocumentUrl(row.documentUrl);
  const stopDrainToken = parseOptionalStopDrainToken(row.stopDrainToken);

  if (
    documentUrl === null ||
    stopDrainToken === null ||
    !isDenseArray(row.events, CONTENT_EVENT_BATCH_MAX, 1)
  ) {
    return null;
  }

  const events: RawRecorderEvent[] = [];
  const budget: PayloadBudget = {
    nodes: 0,
    stringChars: 0
  };

  for (const value of row.events) {
    const event = parseRawContentEvent(value, budget);

    if (!event) {
      return null;
    }

    events.push(event);
  }

  return {
    kind: "content.events",
    events,
    ...(documentUrl === undefined ? {} : { documentUrl }),
    ...(stopDrainToken === undefined ? {} : { stopDrainToken })
  };
}

function parseContentMarker(row: Record<string, unknown>): ExtensionInboundMessage | null {
  if (
    !hasExactKeys(row, CONTENT_MARKER_KEYS) ||
    typeof row.message !== "string" ||
    row.message.length === 0 ||
    row.message.length > MAX_MARKER_CHARS
  ) {
    return null;
  }

  const documentUrl = parseDocumentUrl(row.documentUrl);

  if (documentUrl === null) {
    return null;
  }

  return {
    kind: "content.marker",
    message: row.message,
    ...(documentUrl === undefined ? {} : { documentUrl })
  };
}

function parseContentReady(row: Record<string, unknown>): ExtensionInboundMessage | null {
  if (!hasExactKeys(row, CONTENT_READY_KEYS)) {
    return null;
  }

  const documentUrl = parseDocumentUrl(row.documentUrl);

  if (documentUrl === null) {
    return null;
  }

  return {
    kind: "content.ready",
    ...(documentUrl === undefined ? {} : { documentUrl })
  };
}

function parseContentStopDrained(row: Record<string, unknown>): ExtensionInboundMessage | null {
  if (
    !hasExactKeys(row, CONTENT_STOP_DRAINED_KEYS) ||
    !isIdentifier(row.sid, false) ||
    !isStopDrainToken(row.token)
  ) {
    return null;
  }

  const documentUrl = parseDocumentUrl(row.documentUrl);

  if (typeof documentUrl !== "string") {
    return null;
  }

  return {
    kind: "content.stop-drained",
    sid: row.sid,
    token: row.token,
    documentUrl
  };
}

function parseOptionalStopDrainToken(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  return isStopDrainToken(value) ? value : null;
}

function parseRawContentEvent(value: unknown, budget: PayloadBudget): RawRecorderEvent | null {
  const row = asPlainRecord(value);

  if (
    !row ||
    !hasExactKeys(row, RAW_EVENT_KEYS) ||
    row.source !== "content" ||
    typeof row.rawType !== "string" ||
    !CONTENT_RAW_TYPES.has(row.rawType) ||
    !Number.isSafeInteger(row.tabId) ||
    (row.tabId as number) < -1 ||
    !isIdentifier(row.sid, true) ||
    !isNonNegativeFiniteNumber(row.t) ||
    !isNonNegativeFiniteNumber(row.mono) ||
    (row.frame !== undefined && !isIdentifier(row.frame, false)) ||
    !isPlainRecord(row.payload) ||
    !isBoundedPayload(row.payload, budget)
  ) {
    return null;
  }

  return {
    source: "content",
    rawType: row.rawType,
    tabId: row.tabId as number,
    sid: row.sid,
    t: row.t,
    mono: row.mono,
    ...(row.frame === undefined ? {} : { frame: row.frame }),
    payload: row.payload
  };
}

function parseExportPolicy(value: unknown): UiExportSessionMessage["policy"] | null {
  if (value === undefined) {
    return undefined;
  }

  const row = asPlainRecord(value);

  if (!row || !hasExactKeys(row, EXPORT_POLICY_KEYS)) {
    return null;
  }

  const includeScreenshots = parseOptionalBoolean(row.includeScreenshots);
  const includeScreenRecordings = parseOptionalBoolean(row.includeScreenRecordings);
  const maxArchiveBytes = parseOptionalBoundedInteger(
    row.maxArchiveBytes,
    64 * 1024,
    MAX_EXPORT_BYTES
  );
  const recentWindowMs = parseOptionalBoundedInteger(
    row.recentWindowMs,
    60_000,
    MAX_EXPORT_WINDOW_MS
  );

  if (
    includeScreenshots === null ||
    includeScreenRecordings === null ||
    maxArchiveBytes === null ||
    recentWindowMs === null
  ) {
    return null;
  }

  return {
    ...(includeScreenshots === undefined ? {} : { includeScreenshots }),
    ...(includeScreenRecordings === undefined ? {} : { includeScreenRecordings }),
    ...(maxArchiveBytes === undefined ? {} : { maxArchiveBytes }),
    ...(recentWindowMs === undefined ? {} : { recentWindowMs })
  };
}

function isBoundedPayload(value: Record<string, unknown>, budget: PayloadBudget): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();

  while (stack.length > 0) {
    const current = stack.pop();

    if (!current || current.depth > MAX_PAYLOAD_DEPTH) {
      return false;
    }

    const item = current.value;
    budget.nodes += 1;

    if (budget.nodes > MAX_PAYLOAD_NODES) {
      return false;
    }

    if (item === null || item === undefined || typeof item === "boolean") {
      continue;
    }

    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        return false;
      }
      continue;
    }

    if (typeof item === "string") {
      if (item.length > MAX_PAYLOAD_STRING_CHARS) {
        return false;
      }

      budget.stringChars += item.length;

      if (budget.stringChars > MAX_BATCH_PAYLOAD_STRING_CHARS) {
        return false;
      }
      continue;
    }

    if (typeof item !== "object") {
      return false;
    }

    if (seen.has(item)) {
      return false;
    }
    seen.add(item);

    if (Array.isArray(item)) {
      if (!isDenseArray(item, MAX_PAYLOAD_NODES)) {
        return false;
      }

      for (let index = item.length - 1; index >= 0; index -= 1) {
        stack.push({ value: item[index], depth: current.depth + 1 });
      }
      continue;
    }

    const row = asPlainRecord(item);

    if (!row) {
      return false;
    }

    const keys = Object.keys(row);

    if (keys.length > MAX_PAYLOAD_OBJECT_KEYS) {
      return false;
    }

    for (const key of keys) {
      if (key.length > MAX_IDENTIFIER_CHARS) {
        return false;
      }

      budget.stringChars += key.length;

      if (budget.stringChars > MAX_BATCH_PAYLOAD_STRING_CHARS) {
        return false;
      }

      stack.push({ value: row[key], depth: current.depth + 1 });
    }
  }

  return true;
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) {
    return null;
  }

  const ownKeys = Reflect.ownKeys(value);

  for (const key of ownKeys) {
    if (typeof key !== "string") {
      return null;
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      return null;
    }
  }

  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(row: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const keys = Object.keys(row);
  return keys.length <= allowed.size && keys.every((key) => allowed.has(key));
}

function isDenseArray(value: unknown, maxLength: number, minLength = 0): value is unknown[] {
  if (!Array.isArray(value) || value.length < minLength || value.length > maxLength) {
    return false;
  }

  const ownKeys = Reflect.ownKeys(value);

  if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));

    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      return false;
    }
  }

  return true;
}

function parseOptionalTabId(value: unknown): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function parseOptionalBoolean(value: unknown): boolean | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  return typeof value === "boolean" ? value : null;
}

function parseOptionalBoundedInteger(
  value: unknown,
  min: number,
  max: number
): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
    ? (value as number)
    : null;
}

function parseOptionalBoundedString(value: unknown, maxChars: number): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  return typeof value === "string" && value.length <= maxChars ? value : null;
}

function parseOptionalTags(value: unknown): string[] | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (!isDenseArray(value, MAX_TAGS)) {
    return null;
  }

  if (
    !value.every((tag): tag is string => typeof tag === "string" && tag.length <= MAX_TAG_CHARS)
  ) {
    return null;
  }

  return [...value];
}

function parseDocumentUrl(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_DOCUMENT_URL_CHARS ||
    !parseUrl(value)
  ) {
    return null;
  }

  return value;
}

function isIdentifier(value: unknown, allowEmpty: boolean): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_IDENTIFIER_CHARS &&
    (allowEmpty || value.length > 0)
  );
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
