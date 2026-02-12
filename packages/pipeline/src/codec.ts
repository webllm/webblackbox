import type { WebBlackboxEvent } from "@webblackbox/protocol";

export function encodeEventsNdjson(events: WebBlackboxEvent[]): Uint8Array {
  const lines = events.map((event) => JSON.stringify(event)).join("\n");
  return new TextEncoder().encode(lines);
}

export function decodeEventsNdjson(input: string | Uint8Array): WebBlackboxEvent[] {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);

  if (!text.trim()) {
    return [];
  }

  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as WebBlackboxEvent);
}
