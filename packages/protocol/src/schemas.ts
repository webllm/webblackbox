import { z } from "zod";

import {
  ARCHIVE_PBKDF2_MAX_ITERATIONS,
  ARCHIVE_PBKDF2_MIN_ITERATIONS,
  CAPTURE_MODES,
  CHUNK_CODECS,
  EVENT_LEVELS,
  FREEZE_REASONS,
  STORAGE_SNAPSHOT_MODES,
  WEBBLACKBOX_EVENT_TYPES,
  WEBBLACKBOX_PROTOCOL_VERSION
} from "./constants.js";

const recordStringUnknown = z.record(z.string(), z.unknown());

const stringArray = z.array(z.string());

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

// 16 bytes encoded as canonical padded base64 (22 data characters plus "==").
const archiveSaltBase64Schema = z.string().regex(/^[A-Za-z0-9+/]{21}[AQgw]==$/);

// 12 bytes encoded as canonical unpadded base64.
const archiveIvBase64Schema = z.string().regex(/^[A-Za-z0-9+/]{16}$/);

export const eventLevelSchema = z.enum(EVENT_LEVELS);

export const captureModeSchema = z.enum(CAPTURE_MODES);

export const chunkCodecSchema = z.enum(CHUNK_CODECS);

export const freezeReasonSchema = z.enum(FREEZE_REASONS);

export const storageSnapshotModeSchema = z.enum(STORAGE_SNAPSHOT_MODES);

export const webBlackboxEventTypeSchema = z.enum(WEBBLACKBOX_EVENT_TYPES);

export const eventReferenceSchema = z
  .object({
    act: z.string().min(1).optional(),
    req: z.string().min(1).optional(),
    mut: z.string().min(1).optional(),
    shot: z.string().min(1).optional(),
    err: z.string().min(1).optional(),
    task: z.string().min(1).optional(),
    prev: z.string().min(1).optional()
  })
  .strict();

export const privacyClassificationSchema = z
  .object({
    category: z.enum([
      "actions",
      "inputs",
      "dom",
      "screenshots",
      "screenRecordings",
      "console",
      "network",
      "storage",
      "performance",
      "system"
    ]),
    sensitivity: z.enum(["low", "medium", "high"]),
    redacted: z.boolean()
  })
  .strict();

export const eventEnvelopeSchema = z
  .object({
    v: z.literal(WEBBLACKBOX_PROTOCOL_VERSION),
    sid: z.string().min(1),
    tab: z.number().int().nonnegative(),
    nav: z.string().min(1).optional(),
    frame: z.string().min(1).optional(),
    tgt: z.string().min(1).optional(),
    cdp: z.string().min(1).optional(),
    t: z.number().finite(),
    mono: z.number().finite(),
    dt: z.number().finite().optional(),
    type: webBlackboxEventTypeSchema,
    id: z.string().min(1),
    lvl: eventLevelSchema.optional(),
    ref: eventReferenceSchema.optional(),
    privacy: privacyClassificationSchema.optional(),
    data: z.unknown()
  })
  .strict();

export const samplingProfileSchema = z
  .object({
    mousemoveHz: z.number().int().positive(),
    scrollHz: z.number().int().positive(),
    domFlushMs: z.number().int().positive(),
    screenshotIdleMs: z.number().int().nonnegative(),
    snapshotIntervalMs: z.number().int().positive(),
    actionWindowMs: z.number().int().positive(),
    bodyCaptureMaxBytes: z.number().int().nonnegative()
  })
  .strict();

export const redactionProfileSchema = z
  .object({
    redactHeaders: stringArray,
    redactCookieNames: stringArray,
    redactBodyPatterns: stringArray,
    blockedSelectors: stringArray,
    hashSensitiveValues: z.boolean()
  })
  .strict();

export const siteCapturePolicySchema = z
  .object({
    originPattern: z.string().min(1),
    mode: captureModeSchema,
    enabled: z.boolean(),
    allowBodyCapture: z.boolean(),
    bodyMimeAllowlist: stringArray,
    pathAllowlist: stringArray,
    pathDenylist: stringArray
  })
  .strict();

export const captureConsentSchema = z
  .object({
    id: z.string().min(1),
    provenance: z.enum(["self-recording", "support-assisted", "enterprise-admin-policy"]),
    purpose: z.enum(["debugging", "support", "qa", "incident-response", "other"]),
    grantedBy: z.string().min(1).optional(),
    grantedAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional(),
    revocationRef: z.string().min(1).optional()
  })
  .strict();

export const captureScopeSchema = z
  .object({
    tabId: z.number().int().nonnegative(),
    origin: z.string(),
    allowedOrigins: stringArray,
    deniedOrigins: stringArray,
    includeSubframes: z.boolean(),
    stopOnOriginChange: z.boolean(),
    excludedUrlPatterns: stringArray
  })
  .strict();

export const capturePolicySchema = z
  .object({
    schemaVersion: z.literal(2),
    mode: z.enum(["private", "debug", "lab"]),
    captureContext: z.enum(["real-user", "synthetic", "local-debug"]),
    captureContextEvidenceRef: z.string().min(1).optional(),
    consent: captureConsentSchema,
    unmaskPolicySource: z.enum(["none", "extension-managed", "enterprise", "signed-site-owner"]),
    scope: captureScopeSchema,
    categories: z
      .object({
        actions: z.enum(["metadata", "masked", "allow"]),
        inputs: z.enum(["none", "length-only", "masked", "allow"]),
        dom: z.enum(["off", "wireframe", "masked", "allow"]),
        screenshots: z.enum(["off", "masked", "allow"]),
        screenRecordings: z.enum(["off", "allow"]),
        console: z.enum(["off", "metadata", "sanitized", "allow"]),
        network: z.enum(["metadata", "headers-allowlist", "body-allowlist"]),
        storage: z.enum(["off", "counts-only", "names-only", "lengths-only", "allow"]),
        indexedDb: z.enum(["off", "counts-only", "names-only"]),
        cookies: z.enum(["off", "count-only", "names-only"]),
        cdp: z.enum(["off", "safe-subset", "full"]),
        heapProfiles: z.enum(["off", "lab-only"])
      })
      .strict(),
    redaction: redactionProfileSchema,
    encryption: z
      .object({
        localAtRest: z.literal("required"),
        archive: z.enum(["required", "synthetic-local-debug-exempt", "explicit-low-risk-override"]),
        archiveKeyEnvelope: z.enum([
          "passphrase",
          "enterprise-managed",
          "client-side-share-fragment",
          "none"
        ]),
        overrideReasonRef: z.string().min(1).optional()
      })
      .strict(),
    retention: z
      .object({
        localTtlMs: z.number().int().positive(),
        shareTtlMs: z.number().int().positive().optional()
      })
      .strict()
  })
  .strict();

export const recorderConfigSchema = z
  .object({
    mode: captureModeSchema,
    ringBufferMinutes: z.number().int().positive(),
    freezeOnError: z.boolean(),
    freezeOnNetworkFailure: z.boolean(),
    freezeOnLongTaskSpike: z.boolean(),
    sampling: samplingProfileSchema,
    redaction: redactionProfileSchema,
    capturePolicy: capturePolicySchema.optional(),
    sitePolicies: z.array(siteCapturePolicySchema)
  })
  .strict();

export const sessionMetadataSchema = z
  .object({
    sid: z.string().min(1),
    tabId: z.number().int().nonnegative(),
    windowId: z.number().int().nonnegative().optional(),
    startedAt: z.number().finite(),
    endedAt: z.number().finite().optional(),
    mode: captureModeSchema,
    url: z.string().min(1),
    title: z.string().optional(),
    tags: z.array(z.string())
  })
  .strict();

export const chunkTimeIndexEntrySchema = z
  .object({
    chunkId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    seq: z.number().int().positive(),
    tStart: z.number().finite(),
    tEnd: z.number().finite(),
    monoStart: z.number().finite(),
    monoEnd: z.number().finite(),
    eventCount: z.number().int().positive(),
    byteLength: z.number().int().nonnegative(),
    codec: chunkCodecSchema,
    sha256: sha256HexSchema
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.tStart > entry.tEnd) {
      context.addIssue({
        code: "custom",
        path: ["tEnd"],
        message: "must be greater than or equal to tStart"
      });
    }

    if (entry.monoStart > entry.monoEnd) {
      context.addIssue({
        code: "custom",
        path: ["monoEnd"],
        message: "must be greater than or equal to monoStart"
      });
    }
  });

export const requestIndexEntrySchema = z
  .object({
    reqId: z.string().min(1),
    eventIds: z.array(z.string().min(1)).min(1)
  })
  .strict();

export const invertedIndexEntrySchema = z
  .object({
    term: z.string().min(1),
    eventIds: z.array(z.string().min(1)).min(1)
  })
  .strict();

export const hashesManifestSchema = z
  .object({
    manifestSha256: sha256HexSchema,
    files: z.record(z.string().min(1), sha256HexSchema)
  })
  .strict();

export const exportStatsSchema = z
  .object({
    eventCount: z.number().int().nonnegative(),
    chunkCount: z.number().int().nonnegative(),
    blobCount: z.number().int().nonnegative(),
    durationMs: z.number().finite().nonnegative()
  })
  .strict();

export const exportEncryptionSchema = z
  .object({
    algorithm: z.literal("AES-GCM"),
    kdf: z
      .object({
        name: z.literal("PBKDF2"),
        hash: z.literal("SHA-256"),
        iterations: z
          .number()
          .int()
          .min(ARCHIVE_PBKDF2_MIN_ITERATIONS)
          .max(ARCHIVE_PBKDF2_MAX_ITERATIONS),
        saltBase64: archiveSaltBase64Schema
      })
      .strict(),
    files: z
      .record(
        z.string().min(1),
        z
          .object({
            ivBase64: archiveIvBase64Schema
          })
          .strict()
      )
      .refine((files) => Object.keys(files).length > 0, {
        message: "encrypted archives must declare at least one private file"
      })
  })
  .strict();

export const privacyScannerFindingSchema = z
  .object({
    kind: z.enum([
      "jwt",
      "bearer-token",
      "api-key",
      "oauth-code",
      "session-cookie",
      "email",
      "phone",
      "credit-card",
      "ssn",
      "private-key",
      "long-secret"
    ]),
    severity: z.literal("high"),
    path: z.string().min(1),
    matchCount: z.number().int().positive(),
    sampleSha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

export const privacyScannerResultSchema = z
  .object({
    scannedAt: z.string().datetime(),
    preEncryption: z.boolean(),
    status: z.enum(["passed", "blocked"]),
    findings: z.array(privacyScannerFindingSchema)
  })
  .strict();

export const privacyManifestCategorySummarySchema = z
  .object({
    category: privacyClassificationSchema.shape.category,
    events: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    redacted: z.number().int().nonnegative(),
    unredacted: z.number().int().nonnegative()
  })
  .strict();

export const privacyManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().datetime(),
    effectivePolicy: capturePolicySchema.optional(),
    consent: captureConsentSchema.optional(),
    transfer: z
      .object({
        destination: z.enum([
          "local-download",
          "public-cloud-share",
          "support-upload",
          "enterprise-upload"
        ]),
        archiveKeyEnvelope: z.enum([
          "passphrase",
          "enterprise-managed",
          "client-side-share-fragment",
          "none"
        ]),
        encrypted: z.boolean(),
        includeScreenshots: z.boolean(),
        includeScreenRecordings: z.boolean().default(false),
        maxArchiveBytes: z.number().int().positive().nullable(),
        recentWindowMs: z.number().int().positive().nullable(),
        shareEligible: z.boolean(),
        computedAt: z.string().datetime()
      })
      .strict()
      .optional(),
    categories: z.array(privacyManifestCategorySummarySchema),
    scanner: privacyScannerResultSchema,
    encryption: z
      .object({
        archive: z.enum(["encrypted", "plaintext"]),
        algorithm: z.literal("AES-GCM").optional()
      })
      .strict(),
    totals: z
      .object({
        events: z.number().int().nonnegative(),
        blobs: z.number().int().nonnegative(),
        privacyViolations: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();

export const exportManifestSchema = z
  .object({
    protocolVersion: z.literal(WEBBLACKBOX_PROTOCOL_VERSION),
    createdAt: z.string().datetime(),
    mode: captureModeSchema,
    site: z
      .object({
        origin: z.string().min(1),
        title: z.string().optional()
      })
      .strict(),
    chunkCodec: chunkCodecSchema,
    redactionProfile: redactionProfileSchema,
    stats: exportStatsSchema,
    encryption: exportEncryptionSchema.optional()
  })
  .strict();

export const timeIndexSchema = z.array(chunkTimeIndexEntrySchema);

export const requestIndexSchema = z.array(requestIndexEntrySchema);

export const invertedIndexSchema = z.array(invertedIndexEntrySchema);

export const networkBodyCaptureRuleSchema = z
  .object({
    enabled: z.boolean(),
    mimeAllowlist: z.array(z.string().min(1)),
    maxBytes: z.number().int().positive()
  })
  .strict();

const metaSessionStartSchema = z
  .object({
    url: z.string().min(1).optional(),
    title: z.string().optional(),
    mode: captureModeSchema.optional(),
    permissions: recordStringUnknown.optional(),
    viewport: z
      .object({
        w: z.number().finite(),
        h: z.number().finite(),
        dpr: z.number().finite().optional()
      })
      .strict()
      .optional()
  })
  .strict();

const normalizedNetworkRequestDataSchema = z
  .object({
    reqId: z.string().min(1),
    requestId: z.string().min(1).optional(),
    url: z.string().min(1),
    method: z.string().min(1),
    resourceType: z.string().optional(),
    initiator: recordStringUnknown.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    postDataSize: z.number().int().nonnegative().optional()
  })
  .passthrough();

const cdpNetworkRequestDataSchema = z
  .object({
    requestId: z.string().min(1).optional(),
    request: z
      .object({
        requestId: z.string().min(1).optional(),
        url: z.string().min(1),
        method: z.string().min(1)
      })
      .passthrough()
  })
  .passthrough()
  .refine((value) => Boolean(value.requestId || value.request.requestId), {
    message: "requestId is required"
  });

const networkRequestDataSchema = z.union([
  normalizedNetworkRequestDataSchema,
  cdpNetworkRequestDataSchema
]);

const normalizedNetworkResponseDataSchema = z
  .object({
    reqId: z.string().min(1),
    requestId: z.string().min(1).optional(),
    status: z.number().int(),
    statusText: z.string().optional(),
    mimeType: z.string().optional(),
    fromDiskCache: z.boolean().optional(),
    fromServiceWorker: z.boolean().optional(),
    encodedDataLength: z.number().int().nonnegative().optional(),
    timing: recordStringUnknown.optional(),
    headers: z.record(z.string(), z.string()).optional()
  })
  .passthrough();

const cdpNetworkResponseDataSchema = z
  .object({
    requestId: z.string().min(1),
    response: z
      .object({
        url: z.string().min(1),
        status: z.number().finite()
      })
      .passthrough()
  })
  .passthrough();

const networkResponseDataSchema = z.union([
  normalizedNetworkResponseDataSchema,
  cdpNetworkResponseDataSchema
]);

const consoleEntryDataSchema = z
  .object({
    level: z.enum(["log", "info", "warn", "error", "debug"]),
    method: z.string().optional(),
    source: z.string().optional(),
    text: z.string().optional(),
    stackTop: z.string().optional(),
    args: z.array(z.unknown()).optional(),
    url: z.string().optional(),
    line: z.number().int().optional(),
    col: z.number().int().optional(),
    networkRequestId: z.string().optional(),
    workerId: z.string().optional(),
    executionContextId: z.number().int().optional(),
    timestamp: z.number().finite().optional()
  })
  .strict();

const normalizedErrorExceptionDataSchema = z
  .object({
    message: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    name: z.string().optional(),
    stack: z.string().optional(),
    url: z.string().optional(),
    line: z.number().int().optional(),
    col: z.number().int().optional()
  })
  .passthrough()
  .refine((value) => Boolean(value.message || value.text), {
    message: "message or text is required"
  });

const cdpErrorExceptionDataSchema = z
  .object({
    exceptionDetails: z
      .object({
        text: z.string(),
        exceptionId: z.number().int().optional()
      })
      .passthrough()
  })
  .passthrough();

const errorExceptionDataSchema = z.union([
  normalizedErrorExceptionDataSchema,
  cdpErrorExceptionDataSchema
]);

const screenshotDataSchema = z
  .object({
    shotId: z.string().min(1),
    format: z.enum(["webp", "png"]),
    w: z.number().int().positive().optional(),
    h: z.number().int().positive().optional(),
    quality: z.number().int().min(1).max(100).optional(),
    size: z.number().int().nonnegative().optional(),
    reason: z.string().min(1).optional(),
    viewport: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        dpr: z.number().positive()
      })
      .strict()
      .optional(),
    pointer: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        t: z.number().finite().optional(),
        mono: z.number().finite().optional()
      })
      .strict()
      .optional()
  })
  .strict();

const screenRecordingSourceSchema = z.enum(["tab", "display", "desktop", "window", "screen"]);

const screenRecordingStartDataSchema = z
  .object({
    recordingId: z.string().min(1),
    source: screenRecordingSourceSchema,
    mime: z.string().min(1),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    frameRate: z.number().positive().optional(),
    audio: z.boolean().optional(),
    codec: z.string().min(1).optional()
  })
  .strict();

const screenRecordingChunkDataSchema = z
  .object({
    recordingId: z.string().min(1),
    chunkId: z.string().min(1),
    index: z.number().int().nonnegative(),
    mime: z.string().min(1),
    size: z.number().int().nonnegative(),
    startOffsetMs: z.number().int().nonnegative().optional(),
    endOffsetMs: z.number().int().nonnegative().optional(),
    durationMs: z.number().int().nonnegative().optional()
  })
  .strict();

const screenRecordingEndDataSchema = z
  .object({
    recordingId: z.string().min(1),
    mime: z.string().min(1).optional(),
    chunks: z.array(z.string().min(1)),
    chunkCount: z.number().int().nonnegative(),
    size: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    reason: z.string().min(1).optional()
  })
  .strict();

const screenRecordingErrorDataSchema = z
  .object({
    recordingId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    message: z.string().min(1),
    stage: z.string().min(1).optional()
  })
  .strict();

const domSnapshotDataSchema = z
  .object({
    snapshotId: z.string().min(1),
    contentHash: z.string().min(1),
    source: z.enum(["cdp", "rrweb", "html"]).optional(),
    nodeCount: z.number().int().nonnegative().optional(),
    computedStyles: z.array(z.string()).optional(),
    reason: z.string().min(1).optional()
  })
  .passthrough();

const storageSnapshotDataSchema = z
  .object({
    mode: storageSnapshotModeSchema.optional(),
    hash: z.string().min(1).optional(),
    count: z.number().int().nonnegative().optional(),
    redacted: z.boolean().optional(),
    reason: z.string().min(1).optional()
  })
  .passthrough();

const perfVitalsDataSchema = z
  .object({
    metric: z.string().min(1).optional(),
    name: z.string().optional(),
    startTime: z.number().finite().optional(),
    duration: z.number().finite().optional(),
    value: z.number().finite().optional(),
    lcp: z.number().finite().optional(),
    cls: z.number().finite().optional(),
    inp: z.number().finite().optional(),
    fid: z.number().finite().optional(),
    ttfb: z.number().finite().optional()
  })
  .passthrough();

const genericStrictDataSchema = z.union([
  recordStringUnknown,
  z.array(z.unknown()),
  z.string(),
  z.number(),
  z.boolean(),
  z.null()
]);

const specializedDataSchemas = {
  "meta.session.start": metaSessionStartSchema,
  "network.request": networkRequestDataSchema,
  "network.response": networkResponseDataSchema,
  "console.entry": consoleEntryDataSchema,
  "error.exception": errorExceptionDataSchema,
  "screen.screenshot": screenshotDataSchema,
  "screen.recording.start": screenRecordingStartDataSchema,
  "screen.recording.chunk": screenRecordingChunkDataSchema,
  "screen.recording.end": screenRecordingEndDataSchema,
  "screen.recording.error": screenRecordingErrorDataSchema,
  "dom.snapshot": domSnapshotDataSchema,
  "storage.cookie.snapshot": storageSnapshotDataSchema,
  "storage.local.snapshot": storageSnapshotDataSchema,
  "storage.idb.snapshot": storageSnapshotDataSchema,
  "perf.vitals": perfVitalsDataSchema
} as const;

export function getEventPayloadSchema(type: z.infer<typeof webBlackboxEventTypeSchema>): z.ZodType {
  const knownSchema = specializedDataSchemas[type as keyof typeof specializedDataSchemas];

  return knownSchema ?? genericStrictDataSchema;
}

export function validateEventData(
  type: z.infer<typeof webBlackboxEventTypeSchema>,
  payload: unknown
) {
  return getEventPayloadSchema(type).safeParse(payload);
}

export const webBlackboxEventSchema = eventEnvelopeSchema.superRefine((event, context) => {
  const payloadResult = validateEventData(event.type, event.data);

  if (payloadResult.success) {
    return;
  }

  for (const issue of payloadResult.error.issues) {
    context.addIssue({
      ...issue,
      path: ["data", ...issue.path]
    });
  }
});

export function validateEvent(event: unknown) {
  return webBlackboxEventSchema.safeParse(event);
}
