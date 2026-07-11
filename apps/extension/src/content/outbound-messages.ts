import type { CapturePolicy } from "@webblackbox/protocol";

import {
  parseContentActivationId,
  parseContentEventBatchId,
  parseContentReadyId,
  parseExactPlainOwnDataRecord,
  type ContentActivationId
} from "../shared/content-activation-protocol.js";
import type {
  ContentActivatedMessage,
  ContentBoundMessage,
  ContentDrainMessage,
  ContentEventBatchAckMessage,
  ContentInactiveMessage,
  ContentMainWorldControlResultMessage,
  ContentPrepareMessage,
  ContentQuiesceMessage,
  ContentResetMessage,
  ContentRevokedMessage,
  ContentSameDocumentTransition,
  ContentUrlChangedMessage,
  FreezeNoticeMessage,
  RequestContentReadyMessage
} from "../shared/messages.js";
import {
  parseInjectedDirectControlResult,
  parseMainWorldControllerHint
} from "../shared/main-world-controller.js";
import { isStopDrainToken } from "../shared/stop-drain-token.js";

export type ContentControlMessage =
  | RequestContentReadyMessage
  | ContentPrepareMessage
  | ContentInactiveMessage
  | ContentActivatedMessage
  | ContentBoundMessage
  | ContentEventBatchAckMessage
  | ContentUrlChangedMessage
  | ContentQuiesceMessage
  | ContentDrainMessage
  | ContentRevokedMessage
  | ContentResetMessage
  | FreezeNoticeMessage;

export function parseContentControlMessage(value: unknown): ContentControlMessage | null {
  const envelope = parseExactPlainOwnDataRecordWithAnyKeys(value);
  const kind = envelope?.kind;

  if (typeof kind !== "string") {
    return null;
  }

  switch (kind) {
    case "sw.request-content-ready":
      return parseRequestContentReady(value);
    case "sw.content-prepare":
      return parsePrepare(value);
    case "sw.content-inactive":
      return parseReadyScoped(value, "sw.content-inactive");
    case "sw.content-activated":
      return parseActivationScoped(value, "sw.content-activated");
    case "sw.content-bound":
      return parseActivationScoped(value, "sw.content-bound");
    case "sw.content-events-ack":
      return parseContentEventsAck(value);
    case "sw.content-url":
      return parseContentUrl(value);
    case "sw.content-quiesce":
      return parseActivationScoped(value, "sw.content-quiesce");
    case "sw.content-drain":
      return parseDrain(value);
    case "sw.content-revoked":
      return parseRevoked(value);
    case "sw.content-reset":
      return parseReset(value);
    case "sw.freeze":
      return parseFreeze(value);
    default:
      return null;
  }
}

function parseRequestContentReady(value: unknown): RequestContentReadyMessage | null {
  const kindOnly = parseExactPlainOwnDataRecord(value, ["kind"]);
  if (kindOnly?.kind === "sw.request-content-ready") {
    return { kind: "sw.request-content-ready" };
  }

  const record = parseExactPlainOwnDataRecord(value, ["kind", "sameDocumentTransition"]);

  if (record?.kind !== "sw.request-content-ready") {
    return null;
  }

  const sameDocumentTransition = parseSameDocumentTransition(record.sameDocumentTransition);
  return sameDocumentTransition
    ? { kind: "sw.request-content-ready", sameDocumentTransition }
    : null;
}

function parseSameDocumentTransition(value: unknown): ContentSameDocumentTransition | null {
  const record = parseExactPlainOwnDataRecord(value, [
    "previousActivationId",
    "frameId",
    "documentId",
    "previousDocumentUrl",
    "documentUrl",
    "revision"
  ]);
  const previousActivationId = parseContentActivationId(record?.previousActivationId);

  return record &&
    previousActivationId &&
    Number.isSafeInteger(record.frameId) &&
    (record.frameId as number) >= 0 &&
    isNonEmptyString(record.documentId) &&
    isAbsoluteUrl(record?.previousDocumentUrl) &&
    isAbsoluteUrl(record.documentUrl) &&
    record.previousDocumentUrl !== record.documentUrl &&
    Number.isSafeInteger(record.revision) &&
    (record.revision as number) > 0
    ? {
        previousActivationId,
        frameId: record.frameId as number,
        documentId: record.documentId,
        previousDocumentUrl: record.previousDocumentUrl,
        documentUrl: record.documentUrl,
        revision: record.revision as number
      }
    : null;
}

export function isContentMarkerCommand(value: unknown): boolean {
  const record = parseExactPlainOwnDataRecord(value, ["kind"]);
  return record?.kind === "sw.marker-command";
}

export function parseInjectedBridgeArmedMessage(value: unknown): ContentActivationId | null {
  const record = parseExactPlainOwnDataRecord(value, ["source", "kind", "activationId"]);
  const activationId = parseContentActivationId(record?.activationId);

  return record?.source === "webblackbox-injected" &&
    record.kind === "injected-armed" &&
    activationId
    ? activationId
    : null;
}

function parsePrepare(value: unknown): ContentPrepareMessage | null {
  const record = parseExactPlainOwnDataRecord(value, [
    "kind",
    "readyId",
    "activationId",
    "sid",
    "tabId",
    "mode",
    "sampling",
    "capturePolicy",
    "mainWorldController"
  ]);
  const readyId = parseContentReadyId(record?.readyId);
  const activationId = parseContentActivationId(record?.activationId);
  const sampling = parseSampling(record?.sampling);
  const capturePolicy = parseCapturePolicy(record?.capturePolicy);
  const mainWorldController =
    record?.mainWorldController === null
      ? null
      : (parseMainWorldControllerHint(record?.mainWorldController) ?? undefined);

  if (
    record?.kind !== "sw.content-prepare" ||
    !readyId ||
    !activationId ||
    !isNonEmptyString(record.sid) ||
    !Number.isSafeInteger(record.tabId) ||
    (record.tabId as number) < 0 ||
    (record.mode !== "lite" && record.mode !== "full") ||
    mainWorldController === undefined ||
    (record.mode === "lite" ? mainWorldController === null : mainWorldController !== null) ||
    !sampling ||
    !capturePolicy
  ) {
    return null;
  }

  return {
    kind: "sw.content-prepare",
    readyId,
    activationId,
    sid: record.sid,
    tabId: record.tabId as number,
    mode: record.mode,
    sampling,
    capturePolicy,
    mainWorldController
  };
}

export function parseContentMainWorldControlResult(
  value: unknown
): ContentMainWorldControlResultMessage | null {
  const record = parseExactPlainOwnDataRecord(value, [
    "kind",
    "activationId",
    "operation",
    "controller",
    "result"
  ]);
  const activationId = parseContentActivationId(record?.activationId);
  const controller = parseMainWorldControllerHint(record?.controller);
  const result = parseInjectedDirectControlResult(record?.result);
  return record?.kind === "sw.main-world-control-result" &&
    activationId &&
    (record.operation === "activate" ||
      record.operation === "deactivate" ||
      record.operation === "drain") &&
    controller &&
    result
    ? {
        kind: "sw.main-world-control-result",
        activationId,
        operation: record.operation,
        controller,
        result
      }
    : null;
}

function parseReadyScoped(
  value: unknown,
  kind: ContentInactiveMessage["kind"]
): ContentInactiveMessage | null {
  const record = parseExactPlainOwnDataRecord(value, ["kind", "readyId"]);
  const readyId = parseContentReadyId(record?.readyId);
  return record?.kind === kind && readyId ? { kind, readyId } : null;
}

function parseActivationScoped<
  Message extends ContentActivatedMessage | ContentBoundMessage | ContentQuiesceMessage,
  Kind extends Message["kind"]
>(value: unknown, kind: Kind): Message | null {
  const record = parseExactPlainOwnDataRecord(value, ["kind", "activationId"]);
  const activationId = parseContentActivationId(record?.activationId);
  return record?.kind === kind && activationId ? ({ kind, activationId } as Message) : null;
}

function parseDrain(value: unknown): ContentDrainMessage | null {
  const record = parseExactPlainOwnDataRecord(value, [
    "kind",
    "activationId",
    "sid",
    "token",
    "deadline",
    "documentUrl"
  ]);
  const activationId = parseContentActivationId(record?.activationId);

  if (
    record?.kind !== "sw.content-drain" ||
    !activationId ||
    !isNonEmptyString(record.sid) ||
    !isStopDrainToken(record.token) ||
    typeof record.deadline !== "number" ||
    !Number.isFinite(record.deadline) ||
    !isAbsoluteUrl(record.documentUrl)
  ) {
    return null;
  }

  return {
    kind: "sw.content-drain",
    activationId,
    sid: record.sid,
    token: record.token,
    deadline: record.deadline,
    documentUrl: record.documentUrl
  };
}

function parseContentEventsAck(value: unknown): ContentEventBatchAckMessage | null {
  const record = parseExactPlainOwnDataRecord(value, ["kind", "activationId", "batchId"]);
  const activationId = parseContentActivationId(record?.activationId);
  const batchId = parseContentEventBatchId(record?.batchId);

  return record?.kind === "sw.content-events-ack" && activationId && batchId
    ? { kind: "sw.content-events-ack", activationId, batchId }
    : null;
}

function parseContentUrl(value: unknown): ContentUrlChangedMessage | null {
  const record = parseExactPlainOwnDataRecord(value, [
    "kind",
    "activationId",
    "documentUrl",
    "revision"
  ]);
  const activationId = parseContentActivationId(record?.activationId);

  return record?.kind === "sw.content-url" &&
    activationId &&
    isAbsoluteUrl(record.documentUrl) &&
    Number.isSafeInteger(record.revision) &&
    (record.revision as number) >= 0
    ? {
        kind: "sw.content-url",
        activationId,
        documentUrl: record.documentUrl,
        revision: record.revision as number
      }
    : null;
}

function parseRevoked(value: unknown): ContentRevokedMessage | null {
  const record = parseExactPlainOwnDataRecord(value, ["kind", "activationId", "reason"]);
  const activationId = parseContentActivationId(record?.activationId);
  return record?.kind === "sw.content-revoked" && activationId && isNonEmptyString(record.reason)
    ? { kind: "sw.content-revoked", activationId, reason: record.reason }
    : null;
}

function parseReset(value: unknown): ContentResetMessage | null {
  const record = parseExactPlainOwnDataRecord(value, ["kind", "reason"]);
  return record?.kind === "sw.content-reset" && isNonEmptyString(record.reason)
    ? { kind: "sw.content-reset", reason: record.reason }
    : null;
}

function parseFreeze(value: unknown): FreezeNoticeMessage | null {
  const record = parseExactPlainOwnDataRecord(value, ["kind", "sid", "reason"]);
  return record?.kind === "sw.freeze" &&
    isNonEmptyString(record.sid) &&
    isNonEmptyString(record.reason)
    ? (record as unknown as FreezeNoticeMessage)
    : null;
}

function parseExactPlainOwnDataRecordWithAnyKeys(
  value: unknown
): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      return null;
    }

    return parseExactPlainOwnDataRecord(value, keys as string[]);
  } catch {
    return null;
  }
}

function parseSampling(value: unknown): ContentPrepareMessage["sampling"] | null {
  const record = parseExactPlainOwnDataRecord(value, [
    "mousemoveHz",
    "scrollHz",
    "domFlushMs",
    "snapshotIntervalMs",
    "screenshotIdleMs",
    "bodyCaptureMaxBytes"
  ]);

  if (
    !record ||
    Object.values(record).some(
      (item) => typeof item !== "number" || !Number.isFinite(item) || item < 0
    )
  ) {
    return null;
  }

  return {
    mousemoveHz: record.mousemoveHz as number,
    scrollHz: record.scrollHz as number,
    domFlushMs: record.domFlushMs as number,
    snapshotIntervalMs: record.snapshotIntervalMs as number,
    screenshotIdleMs: record.screenshotIdleMs as number,
    bodyCaptureMaxBytes: record.bodyCaptureMaxBytes as number
  };
}

function parseCapturePolicy(value: unknown): CapturePolicy | null {
  const record = parseAllowedRecord(
    value,
    [
      "schemaVersion",
      "mode",
      "captureContext",
      "consent",
      "unmaskPolicySource",
      "scope",
      "categories",
      "redaction",
      "encryption",
      "retention"
    ],
    ["captureContextEvidenceRef"]
  );
  const consent = parseCaptureConsent(record?.consent);
  const scope = parseCaptureScope(record?.scope);
  const categories = parseCaptureCategories(record?.categories);
  const redaction = parseCaptureRedaction(record?.redaction);
  const encryption = parseCaptureEncryption(record?.encryption);
  const retention = parseCaptureRetention(record?.retention);
  const evidenceRef = record?.captureContextEvidenceRef;

  if (
    record?.schemaVersion !== 2 ||
    !isOneOf(record.mode, ["private", "debug", "lab"] as const) ||
    !isOneOf(record.captureContext, ["real-user", "synthetic", "local-debug"] as const) ||
    (evidenceRef !== undefined && !isNonEmptyString(evidenceRef)) ||
    !consent ||
    !isOneOf(record.unmaskPolicySource, [
      "none",
      "extension-managed",
      "enterprise",
      "signed-site-owner"
    ] as const) ||
    !scope ||
    !categories ||
    !redaction ||
    !encryption ||
    !retention
  ) {
    return null;
  }

  return {
    schemaVersion: 2,
    mode: record.mode,
    captureContext: record.captureContext,
    ...(evidenceRef === undefined ? {} : { captureContextEvidenceRef: evidenceRef }),
    consent,
    unmaskPolicySource: record.unmaskPolicySource,
    scope,
    categories,
    redaction,
    encryption,
    retention
  };
}

function parseCaptureConsent(value: unknown): CapturePolicy["consent"] | null {
  const record = parseAllowedRecord(
    value,
    ["id", "provenance", "purpose", "grantedAt"],
    ["grantedBy", "expiresAt", "revocationRef"]
  );
  if (
    !isNonEmptyString(record?.id) ||
    !isOneOf(record.provenance, [
      "self-recording",
      "support-assisted",
      "enterprise-admin-policy"
    ] as const) ||
    !isOneOf(record.purpose, [
      "debugging",
      "support",
      "qa",
      "incident-response",
      "other"
    ] as const) ||
    !isOptionalNonEmptyString(record.grantedBy) ||
    !isIsoDateTime(record.grantedAt) ||
    (record.expiresAt !== undefined && !isIsoDateTime(record.expiresAt)) ||
    !isOptionalNonEmptyString(record.revocationRef)
  ) {
    return null;
  }

  return {
    id: record.id,
    provenance: record.provenance,
    purpose: record.purpose,
    ...(record.grantedBy === undefined ? {} : { grantedBy: record.grantedBy }),
    grantedAt: record.grantedAt,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    ...(record.revocationRef === undefined ? {} : { revocationRef: record.revocationRef })
  };
}

function parseCaptureScope(value: unknown): CapturePolicy["scope"] | null {
  const record = parseAllowedRecord(value, [
    "tabId",
    "origin",
    "allowedOrigins",
    "deniedOrigins",
    "includeSubframes",
    "stopOnOriginChange",
    "excludedUrlPatterns"
  ]);
  const allowedOrigins = parseStringArray(record?.allowedOrigins);
  const deniedOrigins = parseStringArray(record?.deniedOrigins);
  const excludedUrlPatterns = parseStringArray(record?.excludedUrlPatterns);
  if (
    !record ||
    !Number.isSafeInteger(record.tabId) ||
    (record.tabId as number) < 0 ||
    typeof record.origin !== "string" ||
    !allowedOrigins ||
    !deniedOrigins ||
    typeof record.includeSubframes !== "boolean" ||
    typeof record.stopOnOriginChange !== "boolean" ||
    !excludedUrlPatterns
  ) {
    return null;
  }

  return {
    tabId: record.tabId as number,
    origin: record.origin,
    allowedOrigins,
    deniedOrigins,
    includeSubframes: record.includeSubframes,
    stopOnOriginChange: record.stopOnOriginChange,
    excludedUrlPatterns
  };
}

function parseCaptureCategories(value: unknown): CapturePolicy["categories"] | null {
  const record = parseAllowedRecord(value, [
    "actions",
    "inputs",
    "dom",
    "screenshots",
    "screenRecordings",
    "console",
    "network",
    "storage",
    "indexedDb",
    "cookies",
    "cdp",
    "heapProfiles"
  ]);
  if (
    !isOneOf(record?.actions, ["metadata", "masked", "allow"] as const) ||
    !isOneOf(record.inputs, ["none", "length-only", "masked", "allow"] as const) ||
    !isOneOf(record.dom, ["off", "wireframe", "masked", "allow"] as const) ||
    !isOneOf(record.screenshots, ["off", "masked", "allow"] as const) ||
    !isOneOf(record.screenRecordings, ["off", "allow"] as const) ||
    !isOneOf(record.console, ["off", "metadata", "sanitized", "allow"] as const) ||
    !isOneOf(record.network, ["metadata", "headers-allowlist", "body-allowlist"] as const) ||
    !isOneOf(record.storage, [
      "off",
      "counts-only",
      "names-only",
      "lengths-only",
      "allow"
    ] as const) ||
    !isOneOf(record.indexedDb, ["off", "counts-only", "names-only"] as const) ||
    !isOneOf(record.cookies, ["off", "count-only", "names-only"] as const) ||
    !isOneOf(record.cdp, ["off", "safe-subset", "full"] as const) ||
    !isOneOf(record.heapProfiles, ["off", "lab-only"] as const)
  ) {
    return null;
  }

  return {
    actions: record.actions,
    inputs: record.inputs,
    dom: record.dom,
    screenshots: record.screenshots,
    screenRecordings: record.screenRecordings,
    console: record.console,
    network: record.network,
    storage: record.storage,
    indexedDb: record.indexedDb,
    cookies: record.cookies,
    cdp: record.cdp,
    heapProfiles: record.heapProfiles
  };
}

function parseCaptureRedaction(value: unknown): CapturePolicy["redaction"] | null {
  const record = parseAllowedRecord(value, [
    "redactHeaders",
    "redactCookieNames",
    "redactBodyPatterns",
    "blockedSelectors",
    "hashSensitiveValues"
  ]);
  const redactHeaders = parseStringArray(record?.redactHeaders);
  const redactCookieNames = parseStringArray(record?.redactCookieNames);
  const redactBodyPatterns = parseStringArray(record?.redactBodyPatterns);
  const blockedSelectors = parseStringArray(record?.blockedSelectors);
  if (
    !record ||
    !redactHeaders ||
    !redactCookieNames ||
    !redactBodyPatterns ||
    !blockedSelectors ||
    typeof record.hashSensitiveValues !== "boolean"
  ) {
    return null;
  }

  return {
    redactHeaders,
    redactCookieNames,
    redactBodyPatterns,
    blockedSelectors,
    hashSensitiveValues: record.hashSensitiveValues
  };
}

function parseCaptureEncryption(value: unknown): CapturePolicy["encryption"] | null {
  const record = parseAllowedRecord(
    value,
    ["localAtRest", "archive", "archiveKeyEnvelope"],
    ["overrideReasonRef"]
  );
  if (
    record?.localAtRest !== "required" ||
    !isOneOf(record.archive, [
      "required",
      "synthetic-local-debug-exempt",
      "explicit-low-risk-override"
    ] as const) ||
    !isOneOf(record.archiveKeyEnvelope, [
      "passphrase",
      "enterprise-managed",
      "client-side-share-fragment",
      "none"
    ] as const) ||
    !isOptionalNonEmptyString(record.overrideReasonRef)
  ) {
    return null;
  }

  return {
    localAtRest: "required",
    archive: record.archive,
    archiveKeyEnvelope: record.archiveKeyEnvelope,
    ...(record.overrideReasonRef === undefined
      ? {}
      : { overrideReasonRef: record.overrideReasonRef })
  };
}

function parseCaptureRetention(value: unknown): CapturePolicy["retention"] | null {
  const record = parseAllowedRecord(value, ["localTtlMs"], ["shareTtlMs"]);
  if (
    !isPositiveInteger(record?.localTtlMs) ||
    (record.shareTtlMs !== undefined && !isPositiveInteger(record.shareTtlMs))
  ) {
    return null;
  }

  return {
    localTtlMs: record.localTtlMs,
    ...(record.shareTtlMs === undefined ? {} : { shareTtlMs: record.shareTtlMs })
  };
}

function parseAllowedRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = []
): Readonly<Record<string, unknown>> | null {
  const record = parseExactPlainOwnDataRecordWithAnyKeys(value);
  if (!record) {
    return null;
  }
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  const actualKeys = Object.keys(record);
  return requiredKeys.every((key) => Object.hasOwn(record, key)) &&
    actualKeys.every((key) => allowedKeys.has(key))
    ? record
    : null;
}

function isOneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values
): value is Values[number] {
  return typeof value === "string" && values.includes(value as Values[number]);
}

function parseStringArray(value: unknown): string[] | null {
  try {
    if (!Array.isArray(value)) {
      return null;
    }

    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      return null;
    }

    const length = lengthDescriptor.value as number;
    if (Reflect.ownKeys(value).length !== length + 1) {
      return null;
    }

    const result = new Array<string>(length);
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
        return null;
      }
      result[index] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?Z$/u.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAbsoluteUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) {
    return false;
  }

  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
