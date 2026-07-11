import { capturePolicySchema } from "@webblackbox/protocol";

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
  const capturePolicy = capturePolicySchema.safeParse(record?.capturePolicy);
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
    !capturePolicy.success
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
    capturePolicy: capturePolicy.data,
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
