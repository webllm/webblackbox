import type { RecordingStatusMessage } from "../shared/messages.js";

const UNKNOWN_TAB_ID = -1;

export function resolveRecordingStatusTabId(message: RecordingStatusMessage): number {
  const tabId = message.tabId;
  const scopeTabId = message.capturePolicy?.scope.tabId;

  if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId <= 0) {
    return UNKNOWN_TAB_ID;
  }

  if (Number.isSafeInteger(scopeTabId) && scopeTabId !== tabId) {
    return UNKNOWN_TAB_ID;
  }

  return tabId;
}

export function isRecordingStatusRefreshRequest(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    !Array.isArray(message) &&
    (message as { kind?: unknown }).kind === "sw.request-recording-status"
  );
}

export function resolveRecordingStatusRefreshAction(
  message: unknown,
  bootstrapActive: boolean
): "ignore" | "ack-only" | "ack-and-request" {
  if (!isRecordingStatusRefreshRequest(message)) {
    return "ignore";
  }

  return bootstrapActive ? "ack-and-request" : "ack-only";
}
