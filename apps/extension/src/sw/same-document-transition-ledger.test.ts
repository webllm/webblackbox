import { describe, expect, it } from "vitest";

import { SameDocumentTransitionLedger } from "./same-document-transition-ledger.js";

const ACTIVATION_A = `a1_${"a".repeat(64)}`;
const ACTIVATION_B = `a1_${"b".repeat(64)}`;

describe("SameDocumentTransitionLedger", () => {
  it("chains rapid A-to-B-to-C rotations back to the recoverable A queue", () => {
    const ledger = new SameDocumentTransitionLedger();
    const first = ledger.begin({
      frameId: 0,
      documentId: "document-1",
      currentDocumentUrl: "https://app.example/a",
      nextDocumentUrl: "https://app.example/b",
      revision: 1,
      activeActivationId: ACTIVATION_A
    });
    const superseding = ledger.begin({
      frameId: 0,
      documentId: "document-1",
      currentDocumentUrl: "https://app.example/a",
      nextDocumentUrl: "https://app.example/c",
      revision: 2
    });

    expect(first).toMatchObject({
      previousActivationId: ACTIVATION_A,
      previousDocumentUrl: "https://app.example/a",
      documentUrl: "https://app.example/b",
      revision: 1
    });
    expect(superseding).toMatchObject({
      previousActivationId: ACTIVATION_A,
      previousDocumentUrl: "https://app.example/a",
      documentUrl: "https://app.example/c",
      revision: 2
    });
  });

  it("prefers a newer active owner and ignores stale completion", () => {
    const ledger = new SameDocumentTransitionLedger();
    ledger.begin({
      frameId: 3,
      documentId: "document-child",
      currentDocumentUrl: "https://app.example/a",
      nextDocumentUrl: "https://app.example/b",
      revision: 4,
      activeActivationId: ACTIVATION_A
    });
    const current = ledger.begin({
      frameId: 3,
      documentId: "document-child",
      currentDocumentUrl: "https://app.example/b",
      nextDocumentUrl: "https://app.example/c",
      revision: 5,
      activeActivationId: ACTIVATION_B
    });

    ledger.complete(3, "document-child", 4);
    expect(
      ledger.begin({
        frameId: 3,
        documentId: "document-child",
        currentDocumentUrl: "https://app.example/c",
        nextDocumentUrl: "https://app.example/d",
        revision: 6
      })
    ).toMatchObject({
      previousActivationId: ACTIVATION_B,
      previousDocumentUrl: "https://app.example/b",
      documentUrl: "https://app.example/d"
    });
    ledger.complete(3, "document-child", 6);
    expect(current?.revision).toBe(5);
  });

  it("drops a superseded transition that returns to the original URL", () => {
    const ledger = new SameDocumentTransitionLedger();
    ledger.begin({
      frameId: 0,
      documentId: "document-1",
      currentDocumentUrl: "https://app.example/a",
      nextDocumentUrl: "https://app.example/b",
      revision: 1,
      activeActivationId: ACTIVATION_A
    });

    expect(
      ledger.begin({
        frameId: 0,
        documentId: "document-1",
        currentDocumentUrl: "https://app.example/a",
        nextDocumentUrl: "https://app.example/a",
        revision: 2
      })
    ).toBeUndefined();
  });
});
