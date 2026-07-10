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
