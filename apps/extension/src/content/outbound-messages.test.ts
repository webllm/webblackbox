import { describe, expect, it } from "vitest";

import { DEFAULT_CAPTURE_POLICY } from "@webblackbox/protocol";

import {
  isContentMarkerCommand,
  parseContentControlMessage,
  parseContentMainWorldControlResult
} from "./outbound-messages.js";

const READY_ID = `r1_${"a".repeat(64)}`;
const ACTIVATION_ID = `a1_${"b".repeat(64)}`;
const MAIN_WORLD_CONTROLLER = {
  secret: "e".repeat(64),
  moduleNonce: `m1_${"f".repeat(64)}`,
  revision: 0,
  phase: "inactive",
  activationId: null
};

describe("content outbound control parser", () => {
  it("accepts exact activation controls", () => {
    expect(parseContentControlMessage({ kind: "sw.request-content-ready" })).not.toBeNull();
    expect(
      parseContentControlMessage({
        kind: "sw.request-content-ready",
        sameDocumentTransition: {
          previousActivationId: ACTIVATION_ID,
          frameId: 0,
          documentId: "document-1",
          previousDocumentUrl: "https://app.example/old",
          documentUrl: "https://app.example/new",
          revision: 2
        }
      })
    ).toEqual({
      kind: "sw.request-content-ready",
      sameDocumentTransition: {
        previousActivationId: ACTIVATION_ID,
        frameId: 0,
        documentId: "document-1",
        previousDocumentUrl: "https://app.example/old",
        documentUrl: "https://app.example/new",
        revision: 2
      }
    });
    expect(
      parseContentControlMessage({
        kind: "sw.content-prepare",
        readyId: READY_ID,
        activationId: ACTIVATION_ID,
        sid: "S-content",
        tabId: 7,
        mode: "lite",
        sampling: {
          mousemoveHz: 20,
          scrollHz: 15,
          domFlushMs: 100,
          snapshotIntervalMs: 20_000,
          screenshotIdleMs: 0,
          bodyCaptureMaxBytes: 64_000
        },
        capturePolicy: DEFAULT_CAPTURE_POLICY,
        mainWorldController: MAIN_WORLD_CONTROLLER
      })
    ).not.toBeNull();
    expect(
      parseContentControlMessage({ kind: "sw.content-reset", reason: "restore-failed" })
    ).not.toBeNull();
    expect(
      parseContentControlMessage({ kind: "sw.content-quiesce", activationId: ACTIVATION_ID })
    ).not.toBeNull();
    expect(
      parseContentControlMessage({
        kind: "sw.content-events-ack",
        activationId: ACTIVATION_ID,
        batchId: `b1_${"d".repeat(64)}`
      })
    ).not.toBeNull();
    expect(
      parseContentControlMessage({
        kind: "sw.content-drain",
        activationId: ACTIVATION_ID,
        sid: "S-content",
        token: "c".repeat(64),
        deadline: Date.now() + 1_000,
        documentUrl: "https://app.example/path"
      })
    ).not.toBeNull();
    expect(isContentMarkerCommand({ kind: "sw.marker-command" })).toBe(true);
    expect(
      parseContentMainWorldControlResult({
        kind: "sw.main-world-control-result",
        activationId: ACTIVATION_ID,
        operation: "activate",
        controller: {
          ...MAIN_WORLD_CONTROLLER,
          revision: 1,
          phase: "active",
          activationId: ACTIVATION_ID
        },
        result: { kind: "activated", activationId: ACTIVATION_ID, revision: 1 }
      })
    ).not.toBeNull();
  });

  it("rejects malformed ids, extra fields, symbols, and accessors without invoking them", () => {
    let getterCalls = 0;
    const accessor = { kind: "sw.content-activated" };
    Object.defineProperty(accessor, "activationId", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return ACTIVATION_ID;
      }
    });
    const symbolMessage = { kind: "sw.content-activated", activationId: ACTIVATION_ID };
    Object.defineProperty(symbolMessage, Symbol("hidden"), { value: true });

    expect(parseContentControlMessage(accessor)).toBeNull();
    expect(getterCalls).toBe(0);
    expect(parseContentControlMessage(symbolMessage)).toBeNull();
    expect(
      parseContentControlMessage({
        kind: "sw.content-activated",
        activationId: `a1_${"A".repeat(64)}`
      })
    ).toBeNull();
    expect(
      parseContentControlMessage({
        kind: "sw.content-inactive",
        readyId: READY_ID,
        unexpected: true
      })
    ).toBeNull();
    expect(isContentMarkerCommand({ kind: "sw.marker-command", extra: true })).toBe(false);
    expect(
      parseContentControlMessage({
        kind: "sw.request-content-ready",
        sameDocumentTransition: {
          previousActivationId: ACTIVATION_ID,
          frameId: 0,
          documentId: "document-1",
          previousDocumentUrl: "https://app.example/same",
          documentUrl: "https://app.example/same",
          revision: 1
        }
      })
    ).toBeNull();
  });
});
