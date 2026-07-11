import {
  parseContentActivationId,
  type ContentActivationId
} from "../shared/content-activation-protocol.js";
import type { ContentSameDocumentTransition } from "../shared/messages.js";

export type SameDocumentTransitionInput = Readonly<{
  frameId: number;
  documentId: string;
  currentDocumentUrl: string;
  nextDocumentUrl: string;
  revision: number;
  activeActivationId?: ContentActivationId | string;
}>;

/** Retains the original recoverable queue owner while async URL rotations supersede one another. */
export class SameDocumentTransitionLedger {
  private readonly pending = new Map<string, ContentSameDocumentTransition>();

  public begin(input: SameDocumentTransitionInput): ContentSameDocumentTransition | undefined {
    assertInput(input);
    const key = documentKey(input.frameId, input.documentId);
    const activeActivationId =
      input.activeActivationId === undefined
        ? null
        : parseContentActivationId(input.activeActivationId);

    if (input.activeActivationId !== undefined && !activeActivationId) {
      throw new Error("Invalid active content activation for a same-document transition.");
    }

    if (activeActivationId && input.currentDocumentUrl !== input.nextDocumentUrl) {
      const transition: ContentSameDocumentTransition = {
        previousActivationId: activeActivationId,
        frameId: input.frameId,
        documentId: input.documentId,
        previousDocumentUrl: input.currentDocumentUrl,
        documentUrl: input.nextDocumentUrl,
        revision: input.revision
      };
      this.pending.set(key, transition);
      return transition;
    }

    const predecessor = this.pending.get(key);
    if (!predecessor || input.revision <= predecessor.revision) {
      return undefined;
    }

    if (predecessor.previousDocumentUrl === input.nextDocumentUrl) {
      this.pending.delete(key);
      return undefined;
    }

    const transition: ContentSameDocumentTransition = {
      ...predecessor,
      documentUrl: input.nextDocumentUrl,
      revision: input.revision
    };
    this.pending.set(key, transition);
    return transition;
  }

  public complete(frameId: number, documentId: string, revision: number): void {
    const key = documentKey(frameId, documentId);
    if (this.pending.get(key)?.revision === revision) {
      this.pending.delete(key);
    }
  }

  public clearFrame(frameId: number): void {
    for (const [key, transition] of this.pending) {
      if (transition.frameId === frameId) {
        this.pending.delete(key);
      }
    }
  }

  public clear(): void {
    this.pending.clear();
  }
}

function assertInput(input: SameDocumentTransitionInput): void {
  if (
    !Number.isSafeInteger(input.frameId) ||
    input.frameId < 0 ||
    input.documentId.length === 0 ||
    input.currentDocumentUrl.length === 0 ||
    input.nextDocumentUrl.length === 0 ||
    !Number.isSafeInteger(input.revision) ||
    input.revision <= 0
  ) {
    throw new Error("Invalid same-document transition input.");
  }
}

function documentKey(frameId: number, documentId: string): string {
  return JSON.stringify([frameId, documentId]);
}
