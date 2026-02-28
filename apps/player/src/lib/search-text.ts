import type { WebBlackboxEvent } from "@webblackbox/protocol";
import type { ActionTimelineEntry } from "@webblackbox/player-sdk";

export function buildEventSearchText(event: WebBlackboxEvent): string {
  const refText = event.ref ? JSON.stringify(event.ref) : "";
  const dataText = event.data ? JSON.stringify(event.data) : "";
  return `${event.id} ${event.type} ${refText} ${dataText}`.toLowerCase();
}

export function buildActionSearchText(entry: ActionTimelineEntry): string {
  const requestText = entry.requests
    .map(
      (request) =>
        `${request.reqId} ${request.method} ${request.url} ${request.status ?? ""} ${
          request.failed ? "failed" : ""
        }`
    )
    .join(" ");
  const errorText = entry.errors
    .map((error) => `${error.eventId} ${error.type} ${error.message ?? ""}`)
    .join(" ");

  return `${entry.actId} ${entry.triggerEventId} ${entry.triggerType ?? ""} ${requestText} ${errorText}`.toLowerCase();
}
