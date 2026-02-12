import { z } from "zod";

import {
  chunkCodecSchema,
  eventEnvelopeSchema,
  freezeReasonSchema,
  recorderConfigSchema
} from "./schemas.js";

const arrayBufferSchema = z.custom<ArrayBuffer>((value) => value instanceof ArrayBuffer, {
  message: "Expected ArrayBuffer"
});

export const startSessionMessageSchema = z
  .object({
    t: z.literal("CTRL.START_SESSION"),
    sid: z.string().min(1),
    tabId: z.number().int().nonnegative(),
    mode: z.enum(["lite", "full"]),
    config: recorderConfigSchema
  })
  .strict();

export const stopSessionMessageSchema = z
  .object({
    t: z.literal("CTRL.STOP_SESSION"),
    sid: z.string().min(1),
    tabId: z.number().int().nonnegative(),
    reason: z.string().optional()
  })
  .strict();

export const freezeMessageSchema = z
  .object({
    t: z.literal("CTRL.FREEZE"),
    sid: z.string().min(1),
    tabId: z.number().int().nonnegative(),
    why: freezeReasonSchema
  })
  .strict();

export const exportMessageSchema = z
  .object({
    t: z.literal("CTRL.EXPORT"),
    sid: z.string().min(1),
    passphrase: z.string().min(1).optional()
  })
  .strict();

export const eventBatchMessageSchema = z
  .object({
    t: z.literal("EVT.BATCH"),
    sid: z.string().min(1),
    tabId: z.number().int().nonnegative(),
    seq: z.number().int().nonnegative(),
    events: z.array(eventEnvelopeSchema)
  })
  .strict();

export const blobPutMessageSchema = z
  .object({
    t: z.literal("PIPE.BLOB_PUT"),
    sid: z.string().min(1),
    hash: z.string().min(1),
    mime: z.string().min(1),
    bytes: arrayBufferSchema
  })
  .strict();

export const chunkPutMessageSchema = z
  .object({
    t: z.literal("PIPE.CHUNK_PUT"),
    sid: z.string().min(1),
    chunkId: z.string().min(1),
    tStart: z.number().finite(),
    tEnd: z.number().finite(),
    codec: chunkCodecSchema,
    bytes: arrayBufferSchema,
    sha256: z.string().min(1)
  })
  .strict();

export const buildIndexMessageSchema = z
  .object({
    t: z.literal("PIPE.BUILD_INDEX"),
    sid: z.string().min(1)
  })
  .strict();

export const exportDoneMessageSchema = z
  .object({
    t: z.literal("PIPE.EXPORT_DONE"),
    sid: z.string().min(1),
    size: z.number().int().nonnegative(),
    fileName: z.string().optional()
  })
  .strict();

export const webBlackboxMessageSchema = z.discriminatedUnion("t", [
  startSessionMessageSchema,
  stopSessionMessageSchema,
  freezeMessageSchema,
  exportMessageSchema,
  eventBatchMessageSchema,
  blobPutMessageSchema,
  chunkPutMessageSchema,
  buildIndexMessageSchema,
  exportDoneMessageSchema
]);

export function validateMessage(message: unknown) {
  return webBlackboxMessageSchema.safeParse(message);
}
