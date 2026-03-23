import type { WebBlackboxEvent } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

export type NetworkResponseSummary = {
  reqId: string | null;
  status: number | null;
  ok: boolean | null;
  failed: boolean;
  duration: number | null;
};

export function extractNetworkResponseSummary(payload: unknown): NetworkResponseSummary {
  const record = asRecord(payload);
  const response = asRecord(record?.response);
  const status = asFiniteNumber(response?.status) ?? asFiniteNumber(record?.status);
  const ok = asBoolean(record?.ok);
  const failed =
    record?.failed === true || ok === false || (typeof status === "number" && status >= 400);

  return {
    reqId: extractRequestIdFromPayload(record),
    status,
    ok,
    failed,
    duration: asFiniteNumber(record?.duration)
  };
}
