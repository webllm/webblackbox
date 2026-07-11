import { describe, expect, it } from "vitest";

import { capturePolicySchema, DEFAULT_CAPTURE_POLICY } from "@webblackbox/protocol";

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

function contentPrepareMessage(capturePolicy: unknown): Record<string, unknown> {
  return {
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
    capturePolicy,
    mainWorldController: MAIN_WORLD_CONTROLLER
  };
}

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
      parseContentControlMessage(contentPrepareMessage(DEFAULT_CAPTURE_POLICY))
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

  it("keeps lightweight capture-policy parsing aligned with the protocol schema", () => {
    const completeValidPolicy = {
      ...DEFAULT_CAPTURE_POLICY,
      mode: "lab",
      captureContext: "synthetic",
      captureContextEvidenceRef: "fixture:synthetic-user",
      consent: {
        ...DEFAULT_CAPTURE_POLICY.consent,
        provenance: "support-assisted",
        purpose: "incident-response",
        grantedBy: "support-agent",
        grantedAt: "2028-02-29T23:59Z",
        expiresAt: "2030-01-01T00:00:00.000Z",
        revocationRef: "consent:revocation"
      },
      unmaskPolicySource: "enterprise",
      categories: {
        actions: "allow",
        inputs: "masked",
        dom: "wireframe",
        screenshots: "masked",
        screenRecordings: "allow",
        console: "sanitized",
        network: "headers-allowlist",
        storage: "names-only",
        indexedDb: "names-only",
        cookies: "names-only",
        cdp: "safe-subset",
        heapProfiles: "lab-only"
      },
      encryption: {
        localAtRest: "required",
        archive: "explicit-low-risk-override",
        archiveKeyEnvelope: "enterprise-managed",
        overrideReasonRef: "fixture:override"
      },
      retention: {
        localTtlMs: 60_000,
        shareTtlMs: 30_000
      }
    };
    expect(capturePolicySchema.safeParse(completeValidPolicy).success).toBe(true);
    expect(parseContentControlMessage(contentPrepareMessage(completeValidPolicy))).not.toBeNull();

    const sparseHeaders = new Array<string>(1);
    const invalidPolicies = [
      { ...DEFAULT_CAPTURE_POLICY, unknown: true },
      {
        ...DEFAULT_CAPTURE_POLICY,
        consent: { ...DEFAULT_CAPTURE_POLICY.consent, purpose: "profiling" }
      },
      {
        ...DEFAULT_CAPTURE_POLICY,
        consent: { ...DEFAULT_CAPTURE_POLICY.consent, grantedAt: "not-a-date" }
      },
      {
        ...DEFAULT_CAPTURE_POLICY,
        consent: {
          ...DEFAULT_CAPTURE_POLICY.consent,
          grantedAt: "2023-02-29T00:00:00Z"
        }
      },
      {
        ...DEFAULT_CAPTURE_POLICY,
        consent: {
          ...DEFAULT_CAPTURE_POLICY.consent,
          grantedAt: "2024-04-31T00:00:00Z"
        }
      },
      {
        ...DEFAULT_CAPTURE_POLICY,
        consent: {
          ...DEFAULT_CAPTURE_POLICY.consent,
          grantedAt: "2024-01-01T24:00:00Z"
        }
      },
      {
        ...DEFAULT_CAPTURE_POLICY,
        scope: { ...DEFAULT_CAPTURE_POLICY.scope, tabId: -1 }
      },
      {
        ...DEFAULT_CAPTURE_POLICY,
        categories: { ...DEFAULT_CAPTURE_POLICY.categories, network: "all" }
      },
      {
        ...DEFAULT_CAPTURE_POLICY,
        categories: { ...DEFAULT_CAPTURE_POLICY.categories, unexpected: true }
      },
      {
        ...DEFAULT_CAPTURE_POLICY,
        redaction: {
          ...DEFAULT_CAPTURE_POLICY.redaction,
          redactHeaders: ["authorization", 7]
        }
      },
      {
        ...DEFAULT_CAPTURE_POLICY,
        redaction: { ...DEFAULT_CAPTURE_POLICY.redaction, redactHeaders: sparseHeaders }
      },
      {
        ...DEFAULT_CAPTURE_POLICY,
        encryption: { ...DEFAULT_CAPTURE_POLICY.encryption, overrideReasonRef: "" }
      },
      {
        ...DEFAULT_CAPTURE_POLICY,
        retention: { localTtlMs: 1.5 }
      }
    ];

    for (const policy of invalidPolicies) {
      expect(capturePolicySchema.safeParse(policy).success).toBe(false);
      expect(parseContentControlMessage(contentPrepareMessage(policy))).toBeNull();
    }
  });

  it("rejects nested policy accessors without invoking them", () => {
    let getterCalls = 0;
    const consent = { ...DEFAULT_CAPTURE_POLICY.consent };
    Object.defineProperty(consent, "id", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "consent-id";
      }
    });

    expect(
      parseContentControlMessage(contentPrepareMessage({ ...DEFAULT_CAPTURE_POLICY, consent }))
    ).toBeNull();
    expect(getterCalls).toBe(0);

    const everyGetterHeaders = ["authorization"];
    Object.defineProperty(everyGetterHeaders, "every", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return Array.prototype.every;
      }
    });
    const nonFunctionEveryHeaders = ["authorization"];
    Object.defineProperty(nonFunctionEveryHeaders, "every", {
      enumerable: true,
      value: 0
    });
    const spoofedEveryHeaders = [123];
    Object.defineProperty(spoofedEveryHeaders, "every", {
      enumerable: true,
      value: () => true
    });
    const indexGetterHeaders: string[] = [];
    Object.defineProperty(indexGetterHeaders, "0", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "authorization";
      }
    });
    indexGetterHeaders.length = 1;

    for (const redactHeaders of [
      everyGetterHeaders,
      nonFunctionEveryHeaders,
      spoofedEveryHeaders,
      indexGetterHeaders
    ]) {
      expect(
        parseContentControlMessage(
          contentPrepareMessage({
            ...DEFAULT_CAPTURE_POLICY,
            redaction: { ...DEFAULT_CAPTURE_POLICY.redaction, redactHeaders }
          })
        )
      ).toBeNull();
    }
    expect(getterCalls).toBe(0);
  });

  it("detaches parsed capture-policy arrays from the control message", () => {
    const allowedOrigins = ["https://app.example"];
    const redactHeaders = ["authorization"];
    const policy = {
      ...DEFAULT_CAPTURE_POLICY,
      scope: { ...DEFAULT_CAPTURE_POLICY.scope, allowedOrigins },
      redaction: { ...DEFAULT_CAPTURE_POLICY.redaction, redactHeaders }
    };
    const parsed = parseContentControlMessage(contentPrepareMessage(policy));

    expect(parsed?.kind).toBe("sw.content-prepare");
    if (parsed?.kind !== "sw.content-prepare") {
      throw new Error("expected a parsed prepare control");
    }

    allowedOrigins[0] = "https://mutated.example";
    redactHeaders[0] = "x-mutated";
    expect(parsed.capturePolicy.scope.allowedOrigins).toEqual(["https://app.example"]);
    expect(parsed.capturePolicy.redaction.redactHeaders).toEqual(["authorization"]);
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
