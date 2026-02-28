import type { WebBlackboxEvent } from "@webblackbox/protocol";

import { asRecord, asString } from "./parsing.js";

export function readEventSummaryText(event: WebBlackboxEvent): string {
  const data = asRecord(event.data);
  const first = asString(data?.message) ?? asString(data?.text) ?? asString(data?.error);

  if (first) {
    return first;
  }

  const payload = JSON.stringify(event.data);
  return payload.length > 120 ? payload.slice(0, 120) : payload;
}

export function buildConsoleSignalSearchText(event: WebBlackboxEvent): string {
  return `${event.type} ${stringifySignalPayload(event.data)}`.toLowerCase();
}

export function stringifySignalPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    const serialized = JSON.stringify(value);

    if (typeof serialized === "string") {
      return serialized;
    }
  } catch {
    return "[unserializable payload]";
  }

  return String(value);
}
