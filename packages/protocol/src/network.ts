import type { WebBlackboxEvent } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function extractRequestIdFromPayload(payload: unknown): string | null {
  const record = asRecord(payload);

  return (
    asString(record?.reqId) ??
    asString(record?.requestId) ??
    asString(asRecord(record?.request)?.requestId) ??
    null
  );
}

export function extractRequestId(event: Pick<WebBlackboxEvent, "ref" | "data">): string | null {
  return asString(event.ref?.req) ?? extractRequestIdFromPayload(event.data);
}
