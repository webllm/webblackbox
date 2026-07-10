import type { CapturePolicy } from "@webblackbox/protocol";

export const WEBSOCKET_FRAME_PAYLOAD_PREVIEW_MAX_CHARS = 512;

type NetworkCapturePolicy = CapturePolicy["categories"]["network"];

/**
 * Reduces a CDP WebSocket frame to bounded metadata, adding a payload preview
 * only when the effective network policy explicitly allows response bodies.
 */
export function normalizeWebSocketFramePayload(
  method: string,
  input: unknown,
  networkPolicy: NetworkCapturePolicy | undefined
): Record<string, unknown> {
  const payload = asRecord(input);
  const response = asRecord(payload?.response);
  const frame = asRecord(payload?.frame);
  const responsePayload = asString(response?.payloadData);
  const previewSource =
    responsePayload ??
    asString(frame?.payloadPreview) ??
    asString(payload?.payloadPreview) ??
    asString(payload?.payloadData);
  const declaredPayloadLength = asNonNegativeInteger(frame?.payloadLength);
  const payloadLength =
    responsePayload !== undefined
      ? responsePayload.length
      : (declaredPayloadLength ?? previewSource?.length ?? 0);
  const normalizedFrame: Record<string, unknown> = {
    opcode: asFiniteNumber(frame?.opcode) ?? asFiniteNumber(response?.opcode),
    masked:
      typeof frame?.masked === "boolean"
        ? frame.masked
        : typeof response?.mask === "boolean"
          ? response.mask
          : false,
    payloadLength
  };

  if (networkPolicy === "body-allowlist" && previewSource !== undefined) {
    normalizedFrame.payloadPreview = previewSource.slice(
      0,
      WEBSOCKET_FRAME_PAYLOAD_PREVIEW_MAX_CHARS
    );
  }

  const normalized: Record<string, unknown> = {
    direction: resolveDirection(method, payload),
    frame: normalizedFrame
  };
  const requestId = asString(payload?.requestId);
  const timestamp = asFiniteNumber(payload?.timestamp);

  if (requestId !== undefined) {
    normalized.requestId = requestId;
  }

  if (timestamp !== undefined) {
    normalized.timestamp = timestamp;
  }

  return normalized;
}

function resolveDirection(
  method: string,
  payload: Record<string, unknown> | null
): "sent" | "received" | undefined {
  if (method === "Network.webSocketFrameSent") {
    return "sent";
  }

  if (method === "Network.webSocketFrameReceived") {
    return "received";
  }

  return payload?.direction === "sent" || payload?.direction === "received"
    ? payload.direction
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  const number = asFiniteNumber(value);

  return number !== undefined && number >= 0 ? Math.round(number) : undefined;
}
