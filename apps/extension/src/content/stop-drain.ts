import type { ContentStopDrainedMessage, RecordingStatusMessage } from "../shared/messages.js";
import { isStopDrainToken } from "../shared/stop-drain-token.js";

export type ContentStopDrainContext = {
  token: string;
  deadline: number;
  documentUrl: string;
};

export function resolveContentStopDrainContext(
  message: RecordingStatusMessage,
  topLevel: boolean,
  now = Date.now()
): ContentStopDrainContext | null {
  const drain = message.stopDrain;

  if (
    message.active ||
    !topLevel ||
    !isStopDrainToken(drain?.token) ||
    !Number.isFinite(drain.deadline) ||
    drain.deadline < now ||
    !isAbsoluteUrl(drain.documentUrl)
  ) {
    return null;
  }

  return {
    token: drain.token,
    deadline: drain.deadline,
    documentUrl: drain.documentUrl
  };
}

export function stopDrainEventFields(
  context: ContentStopDrainContext | null,
  fallbackDocumentUrl?: string
): { documentUrl?: string; stopDrainToken?: string } {
  if (context) {
    return { documentUrl: context.documentUrl, stopDrainToken: context.token };
  }

  return fallbackDocumentUrl ? { documentUrl: fallbackDocumentUrl } : {};
}

export function buildContentStopDrainedMessage(
  sid: string | undefined,
  context: ContentStopDrainContext | null
): ContentStopDrainedMessage | null {
  if (!context || typeof sid !== "string" || sid.length === 0) {
    return null;
  }

  return {
    kind: "content.stop-drained",
    sid,
    token: context.token,
    documentUrl: context.documentUrl
  };
}

function isAbsoluteUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }

  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
