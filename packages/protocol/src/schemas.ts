import { z } from "zod";

import {
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

export const recorderConfigSchema = z
  .object({
    mode: captureModeSchema,
    ringBufferMinutes: z.number().int().positive(),
    freezeOnError: z.boolean(),
    freezeOnNetworkFailure: z.boolean(),
    freezeOnLongTaskSpike: z.boolean(),
    sampling: samplingProfileSchema,
    redaction: redactionProfileSchema,
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
    chunkId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    tStart: z.number().finite(),
    tEnd: z.number().finite(),
    monoStart: z.number().finite(),
    monoEnd: z.number().finite(),
    eventCount: z.number().int().nonnegative(),
    byteLength: z.number().int().nonnegative(),
    codec: chunkCodecSchema,
    sha256: z.string().min(1)
  })
  .strict();

export const requestIndexEntrySchema = z
  .object({
    reqId: z.string().min(1),
    eventIds: z.array(z.string().min(1))
  })
  .strict();

export const invertedIndexEntrySchema = z
  .object({
    term: z.string().min(1),
    eventIds: z.array(z.string().min(1))
  })
  .strict();

export const hashesManifestSchema = z
  .object({
    manifestSha256: z.string().min(1),
    files: z.record(z.string(), z.string())
  })
  .strict();

export const exportStatsSchema = z
  .object({
    eventCount: z.number().int().nonnegative(),
    chunkCount: z.number().int().nonnegative(),
    blobCount: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative()
  })
  .strict();

export const exportEncryptionSchema = z
  .object({
    algorithm: z.literal("AES-GCM"),
    kdf: z
      .object({
        name: z.literal("PBKDF2"),
        hash: z.literal("SHA-256"),
        iterations: z.number().int().positive(),
        saltBase64: z.string().min(1)
      })
      .strict(),
    files: z.record(
      z.string(),
      z
        .object({
          ivBase64: z.string().min(1)
        })
        .strict()
    )
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
    url: z.string().min(1),
    title: z.string().optional(),
    mode: captureModeSchema,
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

const networkRequestDataSchema = z
  .object({
    reqId: z.string().min(1),
    url: z.string().min(1),
    method: z.string().min(1),
    resourceType: z.string().optional(),
    initiator: recordStringUnknown.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    postDataSize: z.number().int().nonnegative().optional()
  })
  .strict();

const networkResponseDataSchema = z
  .object({
    reqId: z.string().min(1),
    status: z.number().int(),
    statusText: z.string().optional(),
    mimeType: z.string().optional(),
    fromDiskCache: z.boolean().optional(),
    fromServiceWorker: z.boolean().optional(),
    encodedDataLength: z.number().int().nonnegative().optional(),
    timing: recordStringUnknown.optional(),
    headers: z.record(z.string(), z.string()).optional()
  })
  .strict();

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

const errorExceptionDataSchema = z
  .object({
    message: z.string().min(1),
    name: z.string().optional(),
    stack: z.string().optional(),
    url: z.string().optional(),
    line: z.number().int().optional(),
    col: z.number().int().optional()
  })
  .strict();

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

const domSnapshotDataSchema = z
  .object({
    snapshotId: z.string().min(1),
    contentHash: z.string().min(1),
    source: z.enum(["cdp", "rrweb", "html"]),
    nodeCount: z.number().int().nonnegative().optional(),
    computedStyles: z.array(z.string()).optional()
  })
  .strict();

const storageSnapshotDataSchema = z
  .object({
    mode: storageSnapshotModeSchema.optional(),
    hash: z.string().min(1).optional(),
    count: z.number().int().nonnegative().optional(),
    redacted: z.boolean().optional()
  })
  .strict();

const perfVitalsDataSchema = z
  .object({
    lcp: z.number().finite().optional(),
    cls: z.number().finite().optional(),
    inp: z.number().finite().optional(),
    fid: z.number().finite().optional(),
    ttfb: z.number().finite().optional()
  })
  .strict();

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

export function validateEvent(event: unknown) {
  const envelopeResult = eventEnvelopeSchema.safeParse(event);

  if (!envelopeResult.success) {
    return envelopeResult;
  }

  const payloadResult = validateEventData(envelopeResult.data.type, envelopeResult.data.data);

  if (!payloadResult.success) {
    return payloadResult;
  }

  return envelopeResult;
}
