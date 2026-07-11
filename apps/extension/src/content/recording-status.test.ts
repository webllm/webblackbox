import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import type { RecordingStatusMessage } from "../shared/messages.js";
import {
  isRecordingStatusRefreshRequest,
  resolveRecordingStatusRefreshAction,
  resolveRecordingStatusTabId
} from "./recording-status.js";

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
  it("recognizes only the side-effect-free exact status refresh request", () => {
    expect(isRecordingStatusRefreshRequest({ kind: "sw.request-recording-status" })).toBe(true);
    expect(isRecordingStatusRefreshRequest({ kind: "sw.recording-status", active: false })).toBe(
      false
    );
  });

  it("acknowledges a suspended singleton and waits for pageshow to request status", () => {
    const request = { kind: "sw.request-recording-status" };

    expect(resolveRecordingStatusRefreshAction(request, false)).toBe("ack-only");
    expect(resolveRecordingStatusRefreshAction(request, true)).toBe("ack-and-request");
    expect(resolveRecordingStatusRefreshAction({ kind: "sw.freeze" }, true)).toBe("ignore");
  });

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
