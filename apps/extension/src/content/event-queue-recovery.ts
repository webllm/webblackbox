import type { CaptureMode } from "@webblackbox/protocol";
import type { RawRecorderEvent } from "@webblackbox/recorder";

import type {
  ContentActivationId,
  ContentEventBatchId
} from "../shared/content-activation-protocol.js";
import type { ContentSameDocumentTransition } from "../shared/messages.js";

export type RecoverablePendingContentEventBatch = {
  batchId: ContentEventBatchId;
  events: RawRecorderEvent[];
  documentUrl: string;
  stopDrainToken?: string;
};

export type RecoverableContentEventQueue = Readonly<{
  activationId: ContentActivationId;
  sid: string;
  tabId: number;
  mode: CaptureMode;
  documentUrl: string;
  pendingBatch: RecoverablePendingContentEventBatch | null;
  pendingEvents: RawRecorderEvent[];
}>;

export type ContentEventQueueIdentity = Readonly<{
  activationId: ContentActivationId;
  sid: string;
  tabId: number;
  mode: CaptureMode;
  documentUrl: string;
}>;

export function captureRecoverableContentEventQueue(input: {
  identity: ContentEventQueueIdentity;
  phase: string;
  pendingBatch: RecoverablePendingContentEventBatch | null;
  pendingEvents: readonly RawRecorderEvent[];
}): RecoverableContentEventQueue | null {
  if (
    (input.phase !== "active-bound" && input.phase !== "active-unbound") ||
    input.pendingBatch?.stopDrainToken ||
    (input.pendingBatch === null && input.pendingEvents.length === 0)
  ) {
    return null;
  }

  return {
    ...input.identity,
    pendingBatch: input.pendingBatch
      ? { ...input.pendingBatch, events: [...input.pendingBatch.events] }
      : null,
    pendingEvents: [...input.pendingEvents]
  };
}

export function restoreRecoverableContentEventQueue(
  recovered: RecoverableContentEventQueue | null,
  identity: ContentEventQueueIdentity,
  currentDocumentUrl: string | null,
  pendingEventLimit: number,
  sameDocumentTransition?: ContentSameDocumentTransition
): Readonly<{
  pendingBatch: RecoverablePendingContentEventBatch | null;
  pendingEvents: RawRecorderEvent[];
}> | null {
  if (
    !Number.isSafeInteger(pendingEventLimit) ||
    pendingEventLimit <= 0 ||
    !recovered ||
    recovered.sid !== identity.sid ||
    recovered.tabId !== identity.tabId ||
    recovered.mode !== identity.mode ||
    currentDocumentUrl !== identity.documentUrl ||
    recovered.pendingBatch?.stopDrainToken ||
    (recovered.pendingBatch !== null &&
      (recovered.pendingBatch.documentUrl !== recovered.documentUrl ||
        recovered.pendingBatch.events.length === 0)) ||
    [...(recovered.pendingBatch?.events ?? []), ...recovered.pendingEvents].some(
      (event) =>
        event.source !== "content" || event.sid !== identity.sid || event.tabId !== identity.tabId
    )
  ) {
    return null;
  }

  const sameUrl = recovered.documentUrl === identity.documentUrl;
  const authorizedUrlTransition = Boolean(
    !sameUrl &&
    sameDocumentTransition &&
    sameDocumentTransition.previousActivationId === recovered.activationId &&
    sameDocumentTransition.previousDocumentUrl === recovered.documentUrl &&
    sameDocumentTransition.documentUrl === identity.documentUrl
  );
  if (!sameUrl && !authorizedUrlTransition) {
    return null;
  }

  return {
    pendingBatch: recovered.pendingBatch
      ? {
          ...recovered.pendingBatch,
          documentUrl: identity.documentUrl,
          events: [...recovered.pendingBatch.events]
        }
      : null,
    pendingEvents: recovered.pendingEvents.slice(0, pendingEventLimit)
  };
}
