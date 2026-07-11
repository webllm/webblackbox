import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { assertPrivacyScannerPassed, buildPrivacyManifest } from "./privacy.js";

function createEvent(
  id: string,
  data: unknown = {},
  tab = 2_104_634_568,
  type: WebBlackboxEvent["type"] = "network.request"
): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-privacy-scan",
    tab,
    t: 1_778_655_646_749,
    mono: 1_778_655_646_749.5,
    type,
    id,
    privacy: {
      category: "network",
      sensitivity: "medium",
      redacted: false
    },
    data
  };
}

describe("privacy scanner", () => {
  it("does not treat a legacy passed result without coverage as a complete scan", () => {
    expect(() =>
      assertPrivacyScannerPassed({
        scannedAt: new Date(0).toISOString(),
        preEncryption: true,
        status: "passed",
        findings: []
      })
    ).toThrow(/did not complete/i);
  });

  it("does not classify browser numeric event metadata as phone numbers", async () => {
    const manifest = await buildPrivacyManifest({
      events: [createEvent("E-tab-id")],
      blobs: [],
      encrypted: true
    });

    expect(manifest.scanner.status).toBe("passed");
    expect(manifest.scanner.findings).toEqual([]);
  });

  it("still scans string payload leaves for phone numbers", async () => {
    const manifest = await buildPrivacyManifest({
      events: [createEvent("E-phone", { message: "Call support at 415-555-0101" })],
      blobs: [],
      encrypted: true
    });

    expect(manifest.scanner.status).toBe("blocked");
    expect(manifest.scanner.findings).toMatchObject([
      {
        kind: "phone",
        path: "event:E-phone",
        matchCount: 1
      }
    ]);
  });

  it("does not treat recorder config field names alone as captured secrets", async () => {
    const manifest = await buildPrivacyManifest({
      events: [
        createEvent(
          "E-config",
          {
            redaction: {
              redactHeaders: ["x-api-key"],
              redactBodyPatterns: ["private_key"]
            }
          },
          2_104_634_568,
          "meta.config"
        )
      ],
      blobs: [],
      encrypted: true
    });

    expect(manifest.scanner.status).toBe("passed");
  });

  it("does scan attacker-controlled values even when an archive labels them meta.config", async () => {
    const manifest = await buildPrivacyManifest({
      events: [
        createEvent(
          "E-config-secret",
          { exampleOnly: "-----BEGIN PRIVATE KEY-----" },
          2_104_634_568,
          "meta.config"
        )
      ],
      blobs: [],
      encrypted: false
    });

    expect(manifest.scanner).toMatchObject({
      status: "blocked",
      findings: [{ kind: "private-key", path: "event:E-config-secret" }]
    });
  });

  it("preserves event object keys as scanner context", async () => {
    const manifest = await buildPrivacyManifest({
      events: [createEvent("E-key-secret", { api_key: "abcdefghijklmnop" })],
      blobs: [],
      encrypted: false
    });

    expect(manifest.scanner).toMatchObject({
      status: "blocked",
      findings: [{ kind: "api-key", path: "event:E-key-secret" }]
    });
  });

  it("scans sensitive event keys even when their values are not strings", async () => {
    const manifest = await buildPrivacyManifest({
      events: [
        createEvent(
          "E-non-string-key-secret",
          {
            "alice@example.com": true,
            "-----BEGIN PRIVATE KEY-----": null
          },
          2_104_634_568,
          "meta.config"
        )
      ],
      blobs: [],
      encrypted: false
    });

    expect(manifest.scanner.status).toBe("blocked");
    expect(manifest.scanner.findings.map((finding) => finding.kind)).toEqual(
      expect.arrayContaining(["private-key", "email"])
    );
  });

  it("scans asynchronously supplied blobs without retaining a caller-owned collection", async () => {
    async function* blobs() {
      yield {
        hash: "a".repeat(64),
        mime: "application/octet-stream",
        bytes: new Uint8Array([1, 2, 3])
      };
      yield {
        hash: "b".repeat(64),
        mime: "text/plain",
        bytes: new TextEncoder().encode("-----BEGIN PRIVATE KEY-----")
      };
    }

    const manifest = await buildPrivacyManifest({
      events: [],
      blobs: blobs(),
      encrypted: false,
      preEncryption: false
    });

    expect(manifest.totals.blobs).toBe(2);
    expect(manifest.scanner).toMatchObject({
      preEncryption: false,
      status: "blocked",
      findings: [{ kind: "private-key", path: `blob:${"b".repeat(64)}` }]
    });
  });

  it("scans decoded JSON string values instead of trusting their escaped representation", async () => {
    const escapedDash = "\\u002d";
    const bytes = new TextEncoder().encode(
      `{"value":"${escapedDash.repeat(5)}BEGIN PRIVATE KEY${escapedDash.repeat(5)}"}`
    );

    const manifest = await buildPrivacyManifest({
      events: [],
      blobs: [{ hash: "c".repeat(64), mime: "application/json", bytes }],
      encrypted: false,
      preEncryption: false
    });

    expect(manifest.scanner.status).toBe("blocked");
    expect(manifest.scanner.findings).toMatchObject([{ kind: "private-key" }]);
    expect(manifest.scanner.coverage).toMatchObject({
      complete: true,
      scannedBlobCount: 1,
      opaqueBlobCount: 0
    });
  });

  it("retains raw JSON key context while also scanning semantic values", async () => {
    const manifest = await buildPrivacyManifest({
      events: [],
      blobs: [
        {
          hash: "0".repeat(64),
          mime: "application/json",
          bytes: new TextEncoder().encode('{"api_key":"abcdefghijklmnop"}')
        }
      ],
      encrypted: false
    });

    expect(manifest.scanner.status).toBe("blocked");
    expect(manifest.scanner.findings).toMatchObject([{ kind: "api-key" }]);
  });

  it("reports invalid UTF-8 text candidates as opaque instead of covered", async () => {
    const secret = "-----BEGIN PRIVATE KEY-----";
    const bytes = new Uint8Array(2 + secret.length * 2);
    bytes.set([0xff, 0xfe]);
    for (let index = 0; index < secret.length; index += 1) {
      bytes[2 + index * 2] = secret.charCodeAt(index);
    }

    const manifest = await buildPrivacyManifest({
      events: [],
      blobs: [{ hash: "d".repeat(64), mime: "application/json", bytes }],
      encrypted: false,
      preEncryption: false
    });

    expect(manifest.scanner.status).toBe("passed");
    expect(manifest.scanner.coverage).toMatchObject({
      complete: false,
      incompleteReason: "decode-failed",
      scannedBlobCount: 0,
      opaqueBlobCount: 1
    });
    expect(() => assertPrivacyScannerPassed(manifest.scanner)).toThrow(/did not complete/i);
  });

  it("still blocks raw findings in malformed JSON while reporting incomplete coverage", async () => {
    const manifest = await buildPrivacyManifest({
      events: [],
      blobs: [
        {
          hash: "2".repeat(64),
          mime: "application/json",
          bytes: new TextEncoder().encode('{"value":"-----BEGIN PRIVATE KEY-----"')
        }
      ],
      encrypted: false
    });

    expect(manifest.scanner).toMatchObject({
      status: "blocked",
      coverage: {
        complete: false,
        incompleteReason: "decode-failed",
        opaqueBlobCount: 1
      }
    });
  });

  it("keeps intentional binary blobs complete for pre-encryption export compatibility", async () => {
    const manifest = await buildPrivacyManifest({
      events: [],
      blobs: [
        {
          hash: "1".repeat(64),
          mime: "application/octet-stream",
          bytes: new Uint8Array([0xff, 0xfe, 0xfd])
        }
      ],
      encrypted: true
    });

    expect(manifest.scanner).toMatchObject({
      status: "passed",
      coverage: {
        complete: true,
        scannedBlobCount: 0,
        opaqueBlobCount: 1
      }
    });
    expect(() => assertPrivacyScannerPassed(manifest.scanner)).not.toThrow();
  });

  it("bounds target bytes and fails closed when export coverage is incomplete", async () => {
    const manifest = await buildPrivacyManifest({
      events: [createEvent("E-large", { value: "x".repeat(512) })],
      blobs: [],
      encrypted: false,
      scan: {
        maxTargetBytes: 60
      }
    });

    expect(manifest.scanner.coverage).toMatchObject({
      complete: false,
      incompleteReason: "target-byte-limit",
      scannedEventCount: 0
    });
    expect(() => assertPrivacyScannerPassed(manifest.scanner)).toThrow(/did not complete/i);
  });

  it("does not trust a caller-supplied source length below the actual blob bytes", async () => {
    const maxTargetBytes = 64;
    const manifest = await buildPrivacyManifest({
      events: [],
      blobs: [
        {
          hash: "6".repeat(64),
          mime: "application/json",
          bytes: new TextEncoder().encode(`{"value":"${"x".repeat(256)}"}`),
          sourceByteLength: 1
        }
      ],
      encrypted: false,
      scan: { maxTargetBytes }
    });

    expect(manifest.scanner.coverage).toMatchObject({
      complete: false,
      incompleteReason: "target-byte-limit",
      scannedBlobCount: 0,
      opaqueBlobCount: 1,
      inspectedBytes: 0
    });
  });

  it("charges raw plus semantic JSON expansion to the target budget", async () => {
    const bytes = new TextEncoder().encode(`{"value":"${"x".repeat(32)}"}`);
    const manifest = await buildPrivacyManifest({
      events: [],
      blobs: [{ hash: "9".repeat(64), mime: "application/json", bytes }],
      encrypted: false,
      scan: { maxTargetBytes: bytes.byteLength + 8 }
    });

    expect(manifest.scanner.coverage).toMatchObject({
      complete: false,
      incompleteReason: "target-byte-limit",
      scannedBlobCount: 0,
      opaqueBlobCount: 1,
      inspectedBytes: bytes.byteLength + 8
    });
  });

  it("bounds intermediate JSON semantic expansion before repeated leaves amplify it", async () => {
    const largeKey = "k".repeat(50 * 1024);
    const bytes = new TextEncoder().encode(JSON.stringify({ [largeKey]: Array(5_000).fill("x") }));
    const maxBytes = 80 * 1024;
    const startedAt = performance.now();

    const manifest = await buildPrivacyManifest({
      events: [],
      blobs: [{ hash: "7".repeat(64), mime: "application/json", bytes }],
      encrypted: false,
      scan: {
        maxTargetBytes: maxBytes,
        maxTotalBytes: maxBytes,
        deadlineMs: 5_000
      }
    });

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(manifest.scanner.coverage).toMatchObject({
      complete: false,
      incompleteReason: "target-byte-limit",
      inspectedBytes: maxBytes,
      opaqueBlobCount: 1
    });
  });

  it("stops at the configured finding bound without consuming later blobs", async () => {
    let blobIteratorStarted = false;
    async function* blobs() {
      blobIteratorStarted = true;
      yield {
        hash: "e".repeat(64),
        mime: "application/json",
        bytes: new TextEncoder().encode("{}")
      };
    }

    const manifest = await buildPrivacyManifest({
      events: [createEvent("E-secret", { value: "-----BEGIN PRIVATE KEY-----" })],
      blobs: blobs(),
      expectedBlobCount: 1,
      encrypted: false,
      scan: {
        maxFindings: 1,
        stopOnFinding: true
      }
    });

    expect(manifest.scanner.status).toBe("blocked");
    expect(manifest.scanner.findings).toHaveLength(1);
    expect(manifest.totals.blobs).toBe(1);
    expect(manifest.scanner.coverage).toMatchObject({
      complete: false,
      incompleteReason: "finding-limit"
    });
    expect(blobIteratorStarted).toBe(false);
  });

  it("rejects a fully traversed blob source that disagrees with its declared total", async () => {
    async function* oneBlob() {
      yield { hash: "8".repeat(64), mime: "application/json", bytes: new Uint8Array() };
    }

    await expect(
      buildPrivacyManifest({
        events: [],
        blobs: oneBlob(),
        expectedBlobCount: 2,
        encrypted: false
      })
    ).rejects.toThrow(/blob source count mismatch/i);
  });

  it("stops scanning when the deadline expires while awaiting a blob source", async () => {
    const blobs: AsyncIterable<{
      hash: string;
      mime: string;
      bytes: Uint8Array;
    }> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise(() => undefined)
        };
      }
    };

    const startedAt = performance.now();
    const manifest = await buildPrivacyManifest({
      events: [],
      blobs,
      expectedBlobCount: 1,
      encrypted: false,
      scan: { deadlineMs: 10 }
    });

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(manifest.totals.blobs).toBe(1);
    expect(manifest.scanner.coverage).toMatchObject({
      complete: false,
      incompleteReason: "deadline",
      scannedBlobCount: 0
    });
  });
});
