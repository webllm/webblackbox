import { describe, expect, it } from "vitest";

import {
  createContentEventBatchId,
  parseContentActivationId
} from "../shared/content-activation-protocol.js";
import {
  captureRecoverableContentEventQueue,
  restoreRecoverableContentEventQueue
} from "./event-queue-recovery.js";

const ACTIVATION_ID = parseContentActivationId(`a1_${"1".repeat(64)}`)!;
const NEXT_ACTIVATION_ID = parseContentActivationId(`a1_${"2".repeat(64)}`)!;
const OTHER_ACTIVATION_ID = parseContentActivationId(`a1_${"3".repeat(64)}`)!;
const IDENTITY = {
  activationId: ACTIVATION_ID,
  sid: "S-content",
  tabId: 7,
  mode: "lite" as const,
  documentUrl: "https://example.test/app"
};

function rawEvent(sid = IDENTITY.sid, tabId = IDENTITY.tabId) {
  return {
    source: "content" as const,
    rawType: "click",
    sid,
    tabId,
    t: 1,
    mono: 1,
    payload: {}
  };
}

function pendingBatch(stopDrainToken?: string) {
  return {
    batchId: createContentEventBatchId({
      getRandomValues(bytes) {
        bytes.fill(9);
        return bytes;
      }
    }),
    events: [rawEvent()],
    documentUrl: IDENTITY.documentUrl,
    ...(stopDrainToken ? { stopDrainToken } : {})
  };
}

describe("content event queue recovery", () => {
  it("preserves the exact unacknowledged batch id and queued suffix for the same identity", () => {
    const batch = pendingBatch();
    const recovered = captureRecoverableContentEventQueue({
      identity: IDENTITY,
      phase: "active-bound",
      pendingBatch: batch,
      pendingEvents: [rawEvent()]
    });
    const restored = restoreRecoverableContentEventQueue(
      recovered,
      IDENTITY,
      IDENTITY.documentUrl,
      1_200
    );

    expect(restored?.pendingBatch?.batchId).toBe(batch.batchId);
    expect(restored?.pendingBatch?.events).toEqual(batch.events);
    expect(restored?.pendingEvents).toHaveLength(1);
    expect(restored?.pendingBatch).not.toBe(batch);
  });

  it("never captures a stop-drain or quiescing queue", () => {
    expect(
      captureRecoverableContentEventQueue({
        identity: IDENTITY,
        phase: "active-bound",
        pendingBatch: pendingBatch("a".repeat(64)),
        pendingEvents: []
      })
    ).toBeNull();
    expect(
      captureRecoverableContentEventQueue({
        identity: IDENTITY,
        phase: "quiescing-bound",
        pendingBatch: pendingBatch(),
        pendingEvents: []
      })
    ).toBeNull();
  });

  it.each([
    ["sid", { ...IDENTITY, sid: "S-other" }],
    ["tab", { ...IDENTITY, tabId: 8 }],
    ["mode", { ...IDENTITY, mode: "full" as const }],
    ["url", { ...IDENTITY, documentUrl: "https://example.test/other" }]
  ])("fails closed when the new activation changes %s identity", (_label, nextIdentity) => {
    const recovered = captureRecoverableContentEventQueue({
      identity: IDENTITY,
      phase: "active-unbound",
      pendingBatch: pendingBatch(),
      pendingEvents: []
    });

    expect(
      restoreRecoverableContentEventQueue(recovered, nextIdentity, nextIdentity.documentUrl, 1_200)
    ).toBeNull();
  });

  it("rejects a local URL drift and mismatched queued event ownership", () => {
    const recovered = captureRecoverableContentEventQueue({
      identity: IDENTITY,
      phase: "active-bound",
      pendingBatch: null,
      pendingEvents: [rawEvent("S-other")]
    });

    expect(
      restoreRecoverableContentEventQueue(recovered, IDENTITY, "https://example.test/drift", 1_200)
    ).toBeNull();
    expect(
      restoreRecoverableContentEventQueue(recovered, IDENTITY, IDENTITY.documentUrl, 1_200)
    ).toBeNull();
  });

  it("atomically rebinds an exact same-document queue to its authorized URL revision", () => {
    const batch = pendingBatch();
    const recovered = captureRecoverableContentEventQueue({
      identity: IDENTITY,
      phase: "active-bound",
      pendingBatch: batch,
      pendingEvents: [rawEvent()]
    });
    const nextIdentity = {
      ...IDENTITY,
      activationId: NEXT_ACTIVATION_ID,
      documentUrl: "https://example.test/next"
    };
    const restored = restoreRecoverableContentEventQueue(
      recovered,
      nextIdentity,
      nextIdentity.documentUrl,
      1_200,
      {
        previousActivationId: IDENTITY.activationId,
        frameId: 0,
        documentId: "document-1",
        previousDocumentUrl: IDENTITY.documentUrl,
        documentUrl: nextIdentity.documentUrl,
        revision: 3
      }
    );

    expect(restored?.pendingBatch).toMatchObject({
      batchId: batch.batchId,
      documentUrl: nextIdentity.documentUrl
    });
    expect(restored?.pendingBatch?.events).toEqual(batch.events);
    expect(restored?.pendingEvents).toEqual([rawEvent()]);
  });

  it("rejects a forged or cross-document queue URL transition", () => {
    const recovered = captureRecoverableContentEventQueue({
      identity: IDENTITY,
      phase: "active-bound",
      pendingBatch: pendingBatch(),
      pendingEvents: []
    });
    const nextIdentity = {
      ...IDENTITY,
      activationId: NEXT_ACTIVATION_ID,
      documentUrl: "https://example.test/next"
    };

    expect(
      restoreRecoverableContentEventQueue(
        recovered,
        nextIdentity,
        nextIdentity.documentUrl,
        1_200,
        {
          previousActivationId: OTHER_ACTIVATION_ID,
          frameId: 0,
          documentId: "document-1",
          previousDocumentUrl: IDENTITY.documentUrl,
          documentUrl: nextIdentity.documentUrl,
          revision: 3
        }
      )
    ).toBeNull();
  });
});
