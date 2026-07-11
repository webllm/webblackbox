import {
  parseContentActivationId,
  type ContentActivationId
} from "../shared/content-activation-protocol.js";
import type { ContentDrainMessage, ContentStopDrainedMessage } from "../shared/messages.js";
import type {
  ContentStopDrainArtifact,
  ContentStopDrainDegradationReason
} from "../shared/messages.js";
import { isStopDrainToken } from "../shared/stop-drain-token.js";

export type ContentStopDrainContext = {
  activationId: ContentActivationId;
  sid: string;
  token: string;
  deadline: number;
  documentUrl: string;
};

export function resolveContentStopDrainContext(
  message: ContentDrainMessage,
  now = Date.now()
): ContentStopDrainContext | null {
  const activationId = parseContentActivationId(message.activationId);

  if (
    !activationId ||
    !isStopDrainToken(message.token) ||
    !Number.isFinite(message.deadline) ||
    message.deadline < now ||
    !isAbsoluteUrl(message.documentUrl) ||
    typeof message.sid !== "string" ||
    message.sid.length === 0
  ) {
    return null;
  }

  return {
    activationId,
    sid: message.sid,
    token: message.token,
    deadline: message.deadline,
    documentUrl: message.documentUrl
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
  context: ContentStopDrainContext | null,
  evidence: Readonly<{
    expectedArtifacts: readonly ContentStopDrainArtifact[];
    emittedArtifacts: readonly ContentStopDrainArtifact[];
    omittedArtifacts: readonly ContentStopDrainArtifact[];
    degradationReasons: readonly ContentStopDrainDegradationReason[];
  }> = {
    expectedArtifacts: [],
    emittedArtifacts: [],
    omittedArtifacts: [],
    degradationReasons: []
  }
): ContentStopDrainedMessage | null {
  if (!context) {
    return null;
  }

  return {
    kind: "content.stop-drained",
    activationId: context.activationId,
    sid: context.sid,
    token: context.token,
    documentUrl: context.documentUrl,
    expectedArtifacts: [...new Set(evidence.expectedArtifacts)],
    emittedArtifacts: [...new Set(evidence.emittedArtifacts)],
    omittedArtifacts: [...new Set(evidence.omittedArtifacts)],
    degradationReasons: [...new Set(evidence.degradationReasons)]
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
