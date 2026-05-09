import { describe, expect, it } from "vitest";

import {
  createSessionId,
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  EventIdFactory,
  capturePolicySchema,
  eventEnvelopeSchema,
  inferBlobFileExtension,
  inferBlobMime,
  extractNetworkResponseSummary,
  extractRequestId,
  extractRequestIdFromPayload,
  exportManifestSchema,
  privacyClassificationSchema,
  privacyManifestSchema,
  validateEvent,
  validateMessage,
  WEBBLACKBOX_PROTOCOL_VERSION,
  routeTemplatePath,
  sanitizeUrlForPrivacy
} from "./index.js";

describe("protocol", () => {
  it("creates deterministic id prefixes", () => {
    const sessionId = createSessionId(1_700_000_000_000);
    const ids = new EventIdFactory();

    expect(sessionId.startsWith("S-1700000000000-")).toBe(true);
    expect(ids.next()).toBe("E-00000001");
    expect(ids.next()).toBe("E-00000002");
  });

  it("validates an event envelope", () => {
    const result = validateEvent({
      v: WEBBLACKBOX_PROTOCOL_VERSION,
      sid: "S-1",
      tab: 1,
      t: Date.now(),
      mono: 42,
      type: "network.request",
      id: "E-1",
      data: {
        reqId: "R-1",
        url: "https://example.com/api",
        method: "GET"
      }
    });

    expect(result.success).toBe(true);
  });

  it("validates control messages", () => {
    const result = validateMessage({
      t: "CTRL.START_SESSION",
      sid: "S-1",
      tabId: 3,
      mode: "lite",
      config: DEFAULT_RECORDER_CONFIG
    });

    expect(result.success).toBe(true);
  });

  it("ships product-safe redaction defaults", () => {
    expect(DEFAULT_RECORDER_CONFIG.redaction.redactHeaders).toEqual(
      expect.arrayContaining(["authorization", "x-api-key", "x-csrf-token"])
    );
    expect(DEFAULT_RECORDER_CONFIG.redaction.redactCookieNames).toEqual(
      expect.arrayContaining(["jwt", "refresh_token", "csrf"])
    );
    expect(DEFAULT_RECORDER_CONFIG.redaction.redactBodyPatterns).toEqual(
      expect.arrayContaining(["credential", "private_key", "api_key"])
    );
    expect(DEFAULT_RECORDER_CONFIG.redaction.blockedSelectors).toEqual(
      expect.arrayContaining(["[data-webblackbox-redact]", "input[autocomplete='cc-number']"])
    );
  });

  it("ships a private capture policy with audit and encryption defaults", () => {
    expect(capturePolicySchema.safeParse(DEFAULT_CAPTURE_POLICY).success).toBe(true);
    expect(DEFAULT_RECORDER_CONFIG.capturePolicy).toEqual(DEFAULT_CAPTURE_POLICY);
    expect(DEFAULT_CAPTURE_POLICY.schemaVersion).toBe(2);
    expect(DEFAULT_CAPTURE_POLICY.captureContext).toBe("real-user");
    expect(DEFAULT_CAPTURE_POLICY.consent.provenance).toBe("self-recording");
    expect(DEFAULT_CAPTURE_POLICY.scope.stopOnOriginChange).toBe(true);
    expect(DEFAULT_CAPTURE_POLICY.categories.inputs).toBe("length-only");
    expect(DEFAULT_CAPTURE_POLICY.categories.screenshots).toBe("off");
    expect(DEFAULT_CAPTURE_POLICY.encryption.archive).toBe("required");
  });

  it("parses export manifest schema", () => {
    const result = exportManifestSchema.safeParse({
      protocolVersion: 1,
      createdAt: "2026-02-13T00:00:00.000Z",
      mode: "full",
      site: {
        origin: "https://example.com",
        title: "Example"
      },
      chunkCodec: "none",
      redactionProfile: DEFAULT_RECORDER_CONFIG.redaction,
      stats: {
        eventCount: 120,
        chunkCount: 3,
        blobCount: 8,
        durationMs: 9000
      }
    });

    expect(result.success).toBe(true);
  });

  it("exposes event envelope schema", () => {
    const parsed = eventEnvelopeSchema.safeParse({
      v: WEBBLACKBOX_PROTOCOL_VERSION,
      sid: "S-2",
      tab: 9,
      t: Date.now(),
      mono: 12.5,
      type: "user.marker",
      id: "E-2",
      privacy: {
        category: "actions",
        sensitivity: "low",
        redacted: true
      },
      data: { message: "bug" }
    });

    expect(parsed.success).toBe(true);
    expect(
      privacyClassificationSchema.safeParse({
        category: "network",
        sensitivity: "high",
        redacted: true
      }).success
    ).toBe(true);
  });

  it("validates archive privacy manifests", () => {
    const result = privacyManifestSchema.safeParse({
      schemaVersion: 1,
      generatedAt: "2026-02-13T00:00:00.000Z",
      effectivePolicy: DEFAULT_CAPTURE_POLICY,
      consent: DEFAULT_CAPTURE_POLICY.consent,
      transfer: {
        destination: "local-download",
        archiveKeyEnvelope: "passphrase",
        encrypted: true,
        includeScreenshots: false,
        maxArchiveBytes: 1048576,
        recentWindowMs: null,
        shareEligible: true,
        computedAt: "2026-02-13T00:00:00.000Z"
      },
      categories: [
        {
          category: "network",
          events: 2,
          low: 0,
          medium: 1,
          high: 1,
          redacted: 2,
          unredacted: 0
        }
      ],
      scanner: {
        scannedAt: "2026-02-13T00:00:00.000Z",
        preEncryption: true,
        status: "passed",
        findings: []
      },
      encryption: {
        archive: "encrypted",
        algorithm: "AES-GCM"
      },
      totals: {
        events: 2,
        blobs: 0,
        privacyViolations: 0
      }
    });

    expect(result.success).toBe(true);
  });

  it("extracts request ids from payloads and event refs", () => {
    expect(extractRequestIdFromPayload({ reqId: "R-1" })).toBe("R-1");
    expect(extractRequestIdFromPayload({ requestId: "R-2" })).toBe("R-2");
    expect(extractRequestIdFromPayload({ request: { requestId: "R-3" } })).toBe("R-3");
    expect(
      extractRequestId({
        ref: { req: "R-ref" },
        data: { requestId: "R-payload" }
      })
    ).toBe("R-ref");
  });

  it("normalizes nested and lite network response payloads", () => {
    expect(
      extractNetworkResponseSummary({
        requestId: "R-1",
        response: {
          status: 200
        }
      })
    ).toMatchObject({
      reqId: "R-1",
      status: 200,
      ok: null,
      failed: false
    });

    expect(
      extractNetworkResponseSummary({
        reqId: "R-2",
        status: 503,
        ok: false,
        duration: 123
      })
    ).toMatchObject({
      reqId: "R-2",
      status: 503,
      ok: false,
      failed: true,
      duration: 123
    });
  });

  it("round-trips blob html mime mappings", () => {
    expect(inferBlobFileExtension("text/html")).toBe("html");
    expect(inferBlobMime("html")).toBe("text/html");
    expect(inferBlobFileExtension("application/json")).toBe("json");
    expect(inferBlobMime("bin")).toBe("application/octet-stream");
  });

  it("sanitizes URLs by stripping query, fragment, and route identifiers", () => {
    expect(
      sanitizeUrlForPrivacy(
        "https://app.example.test/users/alice@example.test/orders/123?token=secret#checkout"
      )
    ).toBe("https://app.example.test/users/:id/orders/:id");
    expect(sanitizeUrlForPrivacy("/reset/abc123def456?code=oauth")).toBe("/reset/:id");
    expect(routeTemplatePath("/tenant/acme42/cases/CASE-12345")).toBe("/tenant/:id/cases/:id");
    expect(sanitizeUrlForPrivacy("#access_token=secret")).toBe("");
    expect(sanitizeUrlForPrivacy("file:///Users/alice/secret-project/index.html")).toBe(
      "file:[redacted]"
    );
    expect(sanitizeUrlForPrivacy("/v1/items/wbb_test_provider_token_000000000000")).toBe("/v1/items/:token");
  });
});
