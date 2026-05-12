import type { WebBlackboxEvent } from "@webblackbox/protocol";

export function shouldUpdateSessionMetadataFromNavigation(
  event: Pick<WebBlackboxEvent, "cdp">,
  payload: unknown
): boolean {
  if (event.cdp) {
    return false;
  }

  const frame = asRecord(asRecord(payload)?.frame);

  if (!frame) {
    return true;
  }

  return !hasString(frame.parentId) && !hasString(frame.parentFrameId);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}
