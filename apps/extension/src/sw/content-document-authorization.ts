export const TOP_CONTENT_FRAME_ID = 0;

export type AuthorizedContentDocument = Readonly<{
  frameId: number;
  documentId: string;
  url: string;
}>;

export type ContentDocumentAuthorizationInput = {
  tabId: number;
  frameId: number;
  documentId?: string;
  url: string;
};

export type ContentDocumentIdentityInput = {
  tabId: number;
  frameId?: number;
  documentId?: string;
  url?: string;
};

export type ContentDocumentScopeInput = Readonly<{
  tabId: number;
  frameId: number;
  documentId: string;
  url: string;
  topLevel: boolean;
}>;

export type ContentDocumentScopeDecision = boolean | Readonly<{ allowed: boolean }>;

export type ContentDocumentScopeEvaluator = (
  input: ContentDocumentScopeInput
) => ContentDocumentScopeDecision | Promise<ContentDocumentScopeDecision>;

export type ExactDocumentInjectionTarget = Readonly<{
  tabId: number;
  documentIds: [string];
}>;

export type CommittedDocumentPreparationResult =
  | Readonly<{
      prepared: true;
      reason: "prepared";
      document: AuthorizedContentDocument;
      target: ExactDocumentInjectionTarget;
    }>
  | Readonly<{
      prepared: false;
      reason: "invalid-navigation" | "scope-denied" | "stale-navigation";
      document: null;
      target: null;
    }>;

type AuthorizationRevision = Readonly<{
  epoch: number;
  frameRevision: number;
}>;

type PendingContentDocument = Readonly<{
  document: AuthorizedContentDocument;
  revision: AuthorizationRevision;
}>;

/**
 * Tracks the exact Chrome document authorized in every frame.
 *
 * Committed navigations remain pending until an exact content-script sender
 * proves the new document identity. WebRequest matching only consults active
 * documents, so navigation commit cannot open an early subresource window.
 */
export class ContentDocumentAuthorization {
  readonly tabId: number;

  private epoch = 0;
  private topBootstrapUrl: string | null = null;
  private readonly frameRevisions = new Map<number, number>();
  private readonly documents = new Map<number, AuthorizedContentDocument>();
  private readonly pendingDocuments = new Map<number, PendingContentDocument>();
  private readonly navigationBlockedFrames = new Set<number>();

  constructor(tabId: number) {
    if (!isFrameOrTabId(tabId)) {
      throw new TypeError("Content document authorization requires a valid tabId.");
    }

    this.tabId = tabId;
  }

  /**
   * Authorizes an exact content-script sender. A pending navigation can only be
   * promoted by the same documentId and URL. Initial child injection is allowed
   * only before that frame has entered a navigation-blocked state.
   */
  authorize(input: ContentDocumentAuthorizationInput): AuthorizedContentDocument | null {
    const normalized = normalizeAuthorizationInput(this.tabId, input);

    if (!normalized) {
      return null;
    }

    const current = this.documents.get(normalized.frameId);

    if (current) {
      if (current.documentId !== normalized.documentId) {
        return null;
      }

      // A same-document history/navigation URL update keeps child identities;
      // callers have already evaluated the new sender URL against policy.
      return current.url === normalized.url ? { ...current } : this.store(normalized);
    }

    const pending = this.pendingDocuments.get(normalized.frameId);

    if (pending) {
      if (!sameDocument(pending.document, normalized)) {
        return null;
      }

      this.pendingDocuments.delete(normalized.frameId);
      this.navigationBlockedFrames.delete(normalized.frameId);
      return this.store(normalized);
    }

    if (normalized.frameId === TOP_CONTENT_FRAME_ID) {
      if (this.topBootstrapUrl !== normalized.url) {
        return null;
      }

      this.topBootstrapUrl = null;
      return this.store(normalized);
    }

    if (this.navigationBlockedFrames.has(normalized.frameId)) {
      return null;
    }

    return this.store(normalized);
  }

  /**
   * Revokes an active frame. documentId makes this conditional, so an old port
   * disconnect cannot remove a replacement document in the reused frame.
   */
  revoke(frameId: number, documentId?: string): boolean {
    const normalizedFrameId = normalizeFrameId(frameId);

    if (normalizedFrameId === null) {
      return false;
    }

    const expectedDocumentId =
      documentId === undefined ? undefined : normalizeDocumentId(documentId);
    if (documentId !== undefined && expectedDocumentId === null) {
      return false;
    }

    const current = this.documents.get(normalizedFrameId);
    if (
      !current ||
      (expectedDocumentId !== undefined && current.documentId !== expectedDocumentId)
    ) {
      return false;
    }

    if (normalizedFrameId === TOP_CONTENT_FRAME_ID) {
      const reconnectUrl = current.url;
      this.invalidateAll();
      this.topBootstrapUrl = reconnectUrl;
    } else {
      this.documents.delete(normalizedFrameId);
      this.navigationBlockedFrames.delete(normalizedFrameId);
      this.bumpFrameRevision(normalizedFrameId);
    }

    return true;
  }

  /** Clears all identities and seeds the URL that an exact top sender must prove. */
  reset(topDocument?: { url: string }): void {
    this.invalidateAll();
    this.topBootstrapUrl = isNonEmptyString(topDocument?.url) ? topDocument.url : null;
  }

  get(frameId: number): AuthorizedContentDocument | null {
    const normalizedFrameId = normalizeFrameId(frameId);
    const document = normalizedFrameId === null ? undefined : this.documents.get(normalizedFrameId);
    return document ? { ...document } : null;
  }

  getPending(frameId: number): AuthorizedContentDocument | null {
    const normalizedFrameId = normalizeFrameId(frameId);
    const pending =
      normalizedFrameId === null ? undefined : this.pendingDocuments.get(normalizedFrameId);
    return pending ? { ...pending.document } : null;
  }

  activeFrameIds(): number[] {
    return [...this.documents.keys()].sort((left, right) => left - right);
  }

  activeDocuments(): AuthorizedContentDocument[] {
    return [...this.documents.values()]
      .sort((left, right) => left.frameId - right.frameId)
      .map((document) => ({ ...document }));
  }

  matchesSender(input: ContentDocumentIdentityInput): boolean {
    const identity = normalizeIdentityInput(this.tabId, input, true);

    if (!identity) {
      return false;
    }

    const authorized = this.documents.get(identity.frameId);
    return authorized ? sameDocument(authorized, identity) : false;
  }

  /** WebRequest access always requires an exact active documentId match. */
  matchesWebRequest(input: ContentDocumentIdentityInput): boolean {
    const identity = normalizeIdentityInput(this.tabId, input, false);

    if (!identity) {
      return false;
    }

    return this.documents.get(identity.frameId)?.documentId === identity.documentId;
  }

  /** Immediately closes a frame while a sub-frame navigation is unresolved. */
  beginNavigation(frameId: number): boolean {
    const normalizedFrameId = normalizeFrameId(frameId);

    if (normalizedFrameId === null) {
      return false;
    }

    if (normalizedFrameId === TOP_CONTENT_FRAME_ID) {
      this.invalidateAll();
      this.navigationBlockedFrames.add(TOP_CONTENT_FRAME_ID);
      this.bumpFrameRevision(TOP_CONTENT_FRAME_ID);
      return true;
    }

    this.documents.delete(normalizedFrameId);
    this.pendingDocuments.delete(normalizedFrameId);
    this.navigationBlockedFrames.add(normalizedFrameId);
    this.bumpFrameRevision(normalizedFrameId);
    return true;
  }

  /**
   * Revokes the old frame before evaluating a committed destination. Allowed
   * destinations become pending exact injection targets, never active capture.
   */
  async prepareCommittedNavigation(
    input: ContentDocumentAuthorizationInput,
    evaluateScope: ContentDocumentScopeEvaluator
  ): Promise<CommittedDocumentPreparationResult> {
    if (input.tabId !== this.tabId) {
      return denied("invalid-navigation");
    }

    const frameId = normalizeFrameId(input.frameId);
    if (frameId === null) {
      return denied("invalid-navigation");
    }

    this.beginNavigation(frameId);
    const revision = this.currentRevision(frameId);
    const normalized = normalizeAuthorizationInput(this.tabId, input);

    if (!normalized) {
      return denied("invalid-navigation");
    }

    const scopeDecision: ContentDocumentScopeDecision = await evaluateScope({
      tabId: this.tabId,
      frameId,
      documentId: normalized.documentId,
      url: normalized.url,
      topLevel: frameId === TOP_CONTENT_FRAME_ID
    });

    if (!this.isCurrentRevision(frameId, revision)) {
      return denied("stale-navigation");
    }

    if (!isScopeAllowed(scopeDecision)) {
      return denied("scope-denied");
    }

    this.pendingDocuments.set(frameId, {
      document: normalized,
      revision
    });

    return {
      prepared: true,
      reason: "prepared",
      document: { ...normalized },
      target: {
        tabId: this.tabId,
        documentIds: [normalized.documentId]
      }
    };
  }

  /** True while the exact navigation is pending or has just been promoted. */
  isCurrentNavigation(frameId: number, documentId: string): boolean {
    const normalizedFrameId = normalizeFrameId(frameId);
    const normalizedDocumentId = normalizeDocumentId(documentId);

    if (normalizedFrameId === null || normalizedDocumentId === null) {
      return false;
    }

    return (
      this.pendingDocuments.get(normalizedFrameId)?.document.documentId === normalizedDocumentId ||
      this.documents.get(normalizedFrameId)?.documentId === normalizedDocumentId
    );
  }

  /**
   * Fails one exact navigation without touching a newer document in the same
   * frame. A matching sender promoted during executeScript is revoked too.
   */
  failNavigation(frameId: number, documentId: string): boolean {
    const normalizedFrameId = normalizeFrameId(frameId);
    const normalizedDocumentId = normalizeDocumentId(documentId);

    if (normalizedFrameId === null || normalizedDocumentId === null) {
      return false;
    }

    const pendingMatches =
      this.pendingDocuments.get(normalizedFrameId)?.document.documentId === normalizedDocumentId;
    const activeMatches =
      this.documents.get(normalizedFrameId)?.documentId === normalizedDocumentId;

    if (!pendingMatches && !activeMatches) {
      return false;
    }

    if (pendingMatches) {
      this.pendingDocuments.delete(normalizedFrameId);
    }
    if (activeMatches) {
      this.documents.delete(normalizedFrameId);
    }
    this.navigationBlockedFrames.add(normalizedFrameId);
    this.bumpFrameRevision(normalizedFrameId);
    return true;
  }

  cancelPendingNavigations(): void {
    for (const [frameId] of this.pendingDocuments) {
      this.navigationBlockedFrames.add(frameId);
      this.bumpFrameRevision(frameId);
    }
    this.pendingDocuments.clear();
  }

  private invalidateAll(): void {
    this.epoch += 1;
    this.topBootstrapUrl = null;
    this.documents.clear();
    this.pendingDocuments.clear();
    this.navigationBlockedFrames.clear();
    this.frameRevisions.clear();
  }

  private currentRevision(frameId: number): AuthorizationRevision {
    return {
      epoch: this.epoch,
      frameRevision: this.frameRevisions.get(frameId) ?? 0
    };
  }

  private bumpFrameRevision(frameId: number): number {
    const revision = (this.frameRevisions.get(frameId) ?? 0) + 1;
    this.frameRevisions.set(frameId, revision);
    return revision;
  }

  private isCurrentRevision(frameId: number, revision: AuthorizationRevision): boolean {
    return (
      revision.epoch === this.epoch && revision.frameRevision === this.frameRevisions.get(frameId)
    );
  }

  private store(document: AuthorizedContentDocument): AuthorizedContentDocument {
    const stored = { ...document };
    this.documents.set(stored.frameId, stored);
    return { ...stored };
  }
}

function normalizeAuthorizationInput(
  expectedTabId: number,
  input: ContentDocumentAuthorizationInput
): AuthorizedContentDocument | null {
  const frameId = normalizeFrameId(input.frameId);
  const documentId = normalizeDocumentId(input.documentId);

  if (
    input.tabId !== expectedTabId ||
    frameId === null ||
    documentId === null ||
    !isNonEmptyString(input.url)
  ) {
    return null;
  }

  return {
    frameId,
    documentId,
    url: input.url
  };
}

function normalizeIdentityInput(
  expectedTabId: number,
  input: ContentDocumentIdentityInput,
  requireUrl: boolean
): AuthorizedContentDocument | null {
  const frameId =
    input.frameId === undefined ? TOP_CONTENT_FRAME_ID : normalizeFrameId(input.frameId);
  const documentId = normalizeDocumentId(input.documentId);
  const url = isNonEmptyString(input.url) ? input.url : null;

  if (
    input.tabId !== expectedTabId ||
    frameId === null ||
    documentId === null ||
    (requireUrl && url === null)
  ) {
    return null;
  }

  return {
    frameId,
    documentId,
    url: url ?? ""
  };
}

function sameDocument(left: AuthorizedContentDocument, right: AuthorizedContentDocument): boolean {
  return (
    left.frameId === right.frameId && left.documentId === right.documentId && left.url === right.url
  );
}

function normalizeFrameId(value: number): number | null {
  return isFrameOrTabId(value) ? value : null;
}

function normalizeDocumentId(value: string | undefined): string | null {
  return isNonEmptyString(value) ? value : null;
}

function isFrameOrTabId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isScopeAllowed(decision: ContentDocumentScopeDecision): boolean {
  return typeof decision === "boolean" ? decision : decision.allowed === true;
}

function denied(
  reason: Exclude<CommittedDocumentPreparationResult["reason"], "prepared">
): CommittedDocumentPreparationResult {
  return {
    prepared: false,
    reason,
    document: null,
    target: null
  };
}
