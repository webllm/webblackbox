import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import type { RecordingStatusMessage } from "../shared/messages.js";
import { resolveRecordingStatusTabId } from "./recording-status.js";

function status(input: Partial<RecordingStatusMessage>): RecordingStatusMessage {
  return {
    kind: "sw.recording-status",
    active: true,
    ...input
  };
}

function capturePolicy(tabId: number) {
  const policy = structuredClone(DEFAULT_RECORDER_CONFIG.capturePolicy!);
  policy.scope.tabId = tabId;
  policy.scope.origin = "https://example.test";
  return policy;
}

describe("resolveRecordingStatusTabId", () => {
  it("preserves the service worker tab identity when it matches capture scope", () => {
    expect(
      resolveRecordingStatusTabId(
        status({
          tabId: 42,
          capturePolicy: capturePolicy(42)
        })
      )
    ).toBe(42);
  });

  it.each([
    status({}),
    status({ tabId: -1 }),
    status({ tabId: 0 }),
    status({ tabId: 42, capturePolicy: capturePolicy(7) })
  ])("fails closed for a missing, invalid, or inconsistent tab identity", (message) => {
    expect(resolveRecordingStatusTabId(message)).toBe(-1);
  });
});
