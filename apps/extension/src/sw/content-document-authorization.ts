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
      reason: "invalid-navigation" | "scope-denied" | "scope-error" | "stale-navigation";
      document: null;
      target: null;
    }>;

type AuthorizationRevision = Readonly<{
  epoch: number;
  frameRevision: number;
}>;

export type ContentNavigationAuthorization = Readonly<{
  frameId: number;
  epoch: number;
  frameRevision: number;
}>;

type PendingContentDocument = {
  document: AuthorizedContentDocument;
  revision: AuthorizationRevision;
  ready: boolean;
  injectionComplete: boolean;
  outcome: PreparingAuthorizationOutcome;
};

type PreparingContentDocument = {
  document: AuthorizedContentDocument;
  revision: AuthorizationRevision;
  ready: boolean;
  outcome: PreparingAuthorizationOutcome;
};

type PreparingAuthorizationOutcome = Readonly<{
  promise: Promise<boolean>;
  resolve: (allowed: boolean) => void;
}>;

type NavigationStart = Readonly<{
  authorization: ContentNavigationAuthorization;
  source: "request" | "commit";
  urls: Set<string>;
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
  private readonly preparingDocuments = new Map<number, PreparingContentDocument>();
  private readonly navigationStarts = new Map<number, NavigationStart>();
  private readonly navigationBlockedFrames = new Set<number>();
  private requireCommittedChildNavigation = false;

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
    return this.authorizeInput(input, true);
  }

  authorizeEvent(input: ContentDocumentAuthorizationInput): AuthorizedContentDocument | null {
    return this.authorizeInput(input, false);
  }

  private authorizeInput(
    input: ContentDocumentAuthorizationInput,
    ready: boolean
  ): AuthorizedContentDocument | null {
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

      if (ready) {
        pending.ready = true;
      }

      if (!pending.ready || !pending.injectionComplete) {
        return null;
      }

      this.pendingDocuments.delete(normalized.frameId);
      this.navigationBlockedFrames.delete(normalized.frameId);
      const authorized = this.store(normalized);
      pending.outcome.resolve(true);
      return authorized;
    }

    const preparing = this.preparingDocuments.get(normalized.frameId);

    if (preparing) {
      if (!sameDocument(preparing.document, normalized)) {
        return null;
      }

      if (ready) {
        preparing.ready = true;
      }
      return null;
    }

    if (normalized.frameId === TOP_CONTENT_FRAME_ID) {
      if (this.topBootstrapUrl !== normalized.url) {
        return null;
      }

      this.topBootstrapUrl = null;
      return this.store(normalized);
    }

    if (
      this.navigationBlockedFrames.has(normalized.frameId) ||
      this.requireCommittedChildNavigation
    ) {
      return null;
    }

    return this.store(normalized);
  }

  /**
   * Runtimes without exact webNavigation tracking may use a new top sender as
   * fallback navigation proof. Exact-tracked runtimes must never use this reset
   * because it would bypass the committed-document gate.
   */
  authorizeTopSender(
    input: ContentDocumentAuthorizationInput,
    options: { allowNavigationFallback: boolean; currentCaptureUrl: string; ready?: boolean }
  ): AuthorizedContentDocument | null {
    const normalized = normalizeAuthorizationInput(this.tabId, input);

    if (!normalized || normalized.frameId !== TOP_CONTENT_FRAME_ID) {
      return null;
    }

    if (options.allowNavigationFallback) {
      const current = this.documents.get(TOP_CONTENT_FRAME_ID);

      if (
        (current && current.documentId !== normalized.documentId) ||
        (!current && options.currentCaptureUrl !== normalized.url)
      ) {
        this.reset({ url: normalized.url });
      }
    }

    const authorizedInput = { tabId: this.tabId, ...normalized };
    return options.ready === false
      ? this.authorizeEvent(authorizedInput)
      : this.authorize(authorizedInput);
  }

  /**
   * Revokes an active frame after an explicit document-lifecycle failure.
   * documentId keeps a late failure from removing a replacement document in
   * the reused frame. Transport disconnects must not call this method.
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

  waitForPreparingAuthorization(input: ContentDocumentAuthorizationInput): Promise<boolean> | null {
    const normalized = normalizeAuthorizationInput(this.tabId, input);

    if (!normalized) {
      return null;
    }

    const preparing = this.preparingDocuments.get(normalized.frameId);

    if (preparing?.ready === true && sameDocument(preparing.document, normalized)) {
      return preparing.outcome.promise;
    }

    const pending = this.pendingDocuments.get(normalized.frameId);
    return pending?.ready === true && sameDocument(pending.document, normalized)
      ? pending.outcome.promise
      : null;
  }

  /**
   * A denied top sender may stop capture when it is the exact active/pending
   * document, or when no top identity/navigation window exists. Stale A
   * senders must never be able to stop an active or pending replacement B/C.
   */
  shouldStopRuntimeForDeniedSender(input: { frameId: number; documentId?: string }): boolean {
    const normalizedFrameId = normalizeFrameId(input.frameId);

    if (normalizedFrameId !== TOP_CONTENT_FRAME_ID) {
      return false;
    }

    const documentId = normalizeDocumentId(input.documentId);
    const preparing = this.preparingDocuments.get(TOP_CONTENT_FRAME_ID);

    if (preparing) {
      return (
        documentId !== null && preparing.document.documentId === documentId && !preparing.ready
      );
    }

    const pending = this.pendingDocuments.get(TOP_CONTENT_FRAME_ID)?.document;

    if (pending) {
      const pendingState = this.pendingDocuments.get(TOP_CONTENT_FRAME_ID)!;
      return documentId !== null && pending.documentId === documentId && !pendingState.ready;
    }

    const active = this.documents.get(TOP_CONTENT_FRAME_ID);

    if (active) {
      return documentId !== null && active.documentId === documentId;
    }

    return !this.navigationBlockedFrames.has(TOP_CONTENT_FRAME_ID);
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

  matchesKnownDocument(input: { frameId: number; documentId?: string }): boolean {
    const frameId = normalizeFrameId(input.frameId);
    const documentId = normalizeDocumentId(input.documentId);

    if (frameId === null || documentId === null) {
      return false;
    }

    return (
      this.documents.get(frameId)?.documentId === documentId ||
      this.pendingDocuments.get(frameId)?.document.documentId === documentId
    );
  }

  /** Immediately closes a frame while a sub-frame navigation is unresolved. */
  beginNavigation(frameId: number, url?: string): ContentNavigationAuthorization | null {
    return this.beginNavigationWithSource(frameId, url, "request");
  }

  continueNavigation(
    authorization: ContentNavigationAuthorization,
    url: string
  ): ContentNavigationAuthorization | null {
    if (!isNonEmptyString(url) || !this.matchesNavigationRevision(authorization)) {
      return null;
    }

    const start = this.navigationStarts.get(authorization.frameId);

    if (!start || !sameNavigationAuthorization(start.authorization, authorization)) {
      return null;
    }

    start.urls.add(url);
    return { ...authorization };
  }

  finalizeNavigation(authorization: ContentNavigationAuthorization): boolean {
    const start = this.navigationStarts.get(authorization.frameId);

    if (
      !start ||
      !sameNavigationAuthorization(start.authorization, authorization) ||
      !this.matchesNavigationRevision(authorization)
    ) {
      return false;
    }

    this.navigationStarts.delete(authorization.frameId);
    return true;
  }

  private beginNavigationWithSource(
    frameId: number,
    url: string | undefined,
    source: NavigationStart["source"]
  ): ContentNavigationAuthorization | null {
    const normalizedFrameId = normalizeFrameId(frameId);

    if (normalizedFrameId === null) {
      return null;
    }

    if (normalizedFrameId === TOP_CONTENT_FRAME_ID) {
      this.invalidateAll();
      this.requireCommittedChildNavigation = true;
      this.navigationBlockedFrames.add(TOP_CONTENT_FRAME_ID);
      this.bumpFrameRevision(TOP_CONTENT_FRAME_ID);
      const authorization = this.toNavigationAuthorization(
        TOP_CONTENT_FRAME_ID,
        this.currentRevision(TOP_CONTENT_FRAME_ID)
      );
      this.storeNavigationStart(authorization, url, source);
      return authorization;
    }

    this.documents.delete(normalizedFrameId);
    this.rejectPendingDocument(normalizedFrameId);
    this.rejectPreparingDocument(normalizedFrameId);
    this.navigationStarts.delete(normalizedFrameId);
    this.navigationBlockedFrames.add(normalizedFrameId);
    this.bumpFrameRevision(normalizedFrameId);
    const authorization = this.toNavigationAuthorization(
      normalizedFrameId,
      this.currentRevision(normalizedFrameId)
    );
    this.storeNavigationStart(authorization, url, source);
    return authorization;
  }

  /**
   * Accepts a navigation completion only while its start revision is still
   * current, or after the exact committed document has become pending/active.
   * This keeps a superseded request completion from reopening an older URL.
   */
  matchesNavigationCompletion(input: {
    authorization: ContentNavigationAuthorization;
    frameId: number;
    documentId?: string;
  }): boolean {
    const frameId = normalizeFrameId(input.frameId);

    if (frameId === null || input.authorization.frameId !== frameId) {
      return false;
    }

    const start = this.navigationStarts.get(frameId);
    return (
      start !== undefined &&
      sameNavigationAuthorization(start.authorization, input.authorization) &&
      this.matchesNavigationRevision(input.authorization)
    );
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

    const normalized = normalizeAuthorizationInput(this.tabId, input);
    const currentStart = this.navigationStarts.get(frameId);

    if (currentStart) {
      if (currentStart.urls.size === 0 && isNonEmptyString(input.url)) {
        currentStart.urls.add(input.url);
      } else if (!currentStart.urls.has(input.url)) {
        if (currentStart.source === "request") {
          return denied("stale-navigation");
        }

        const authorization = this.beginNavigationWithSource(frameId, input.url, "commit");
        if (!authorization) {
          return denied("invalid-navigation");
        }
      }
    } else {
      const authorization = this.beginNavigationWithSource(frameId, input.url, "commit");
      if (!authorization) {
        return denied("invalid-navigation");
      }
    }

    if (this.navigationStarts.get(frameId)?.source === "commit") {
      this.navigationStarts.delete(frameId);
    }

    const revision = this.currentRevision(frameId);

    if (!normalized) {
      return denied("invalid-navigation");
    }

    const preparing: PreparingContentDocument = {
      document: normalized,
      revision,
      ready: false,
      outcome: createPreparingAuthorizationOutcome()
    };
    this.preparingDocuments.set(frameId, preparing);

    let scopeDecision: ContentDocumentScopeDecision;

    try {
      scopeDecision = await evaluateScope({
        tabId: this.tabId,
        frameId,
        documentId: normalized.documentId,
        url: normalized.url,
        topLevel: frameId === TOP_CONTENT_FRAME_ID
      });
    } catch {
      if (!this.isCurrentPreparing(frameId, preparing)) {
        return denied("stale-navigation");
      }

      this.preparingDocuments.delete(frameId);
      preparing.outcome.resolve(false);
      return denied("scope-error");
    }

    if (!this.isCurrentPreparing(frameId, preparing)) {
      return denied("stale-navigation");
    }

    if (!isScopeAllowed(scopeDecision)) {
      this.preparingDocuments.delete(frameId);
      preparing.outcome.resolve(false);
      return denied("scope-denied");
    }

    this.preparingDocuments.delete(frameId);

    this.pendingDocuments.set(frameId, {
      document: normalized,
      revision,
      ready: preparing.ready,
      injectionComplete: false,
      outcome: preparing.outcome
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
      this.preparingDocuments.get(normalizedFrameId)?.document.documentId ===
        normalizedDocumentId ||
      this.documents.get(normalizedFrameId)?.documentId === normalizedDocumentId
    );
  }

  completePendingInjection(frameId: number, documentId: string): boolean {
    const normalizedFrameId = normalizeFrameId(frameId);
    const normalizedDocumentId = normalizeDocumentId(documentId);

    if (normalizedFrameId === null || normalizedDocumentId === null) {
      return false;
    }

    const pending = this.pendingDocuments.get(normalizedFrameId);

    if (!pending || pending.document.documentId !== normalizedDocumentId) {
      return false;
    }

    pending.injectionComplete = true;

    if (pending.ready) {
      this.pendingDocuments.delete(normalizedFrameId);
      this.navigationBlockedFrames.delete(normalizedFrameId);
      this.store(pending.document);
      pending.outcome.resolve(true);
    }

    return true;
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
      this.rejectPendingDocument(normalizedFrameId);
    }
    if (activeMatches) {
      this.documents.delete(normalizedFrameId);
    }
    this.navigationBlockedFrames.add(normalizedFrameId);
    this.bumpFrameRevision(normalizedFrameId);
    return true;
  }

  cancelPendingNavigations(): void {
    this.epoch += 1;

    for (const frameId of new Set([
      ...this.pendingDocuments.keys(),
      ...this.preparingDocuments.keys(),
      ...this.navigationStarts.keys(),
      ...this.navigationBlockedFrames
    ])) {
      this.navigationBlockedFrames.add(frameId);
    }

    this.rejectAllPendingDocuments();
    this.rejectAllPreparingDocuments();
    this.navigationStarts.clear();
  }

  private invalidateAll(): void {
    this.rejectAllPreparingDocuments();
    this.epoch += 1;
    this.topBootstrapUrl = null;
    this.documents.clear();
    this.rejectAllPendingDocuments();
    this.preparingDocuments.clear();
    this.navigationStarts.clear();
    this.navigationBlockedFrames.clear();
    this.frameRevisions.clear();
    this.requireCommittedChildNavigation = false;
  }

  private rejectPreparingDocument(frameId: number): void {
    const preparing = this.preparingDocuments.get(frameId);

    if (preparing) {
      this.preparingDocuments.delete(frameId);
      preparing.outcome.resolve(false);
    }
  }

  private rejectPendingDocument(frameId: number): void {
    const pending = this.pendingDocuments.get(frameId);

    if (pending) {
      this.pendingDocuments.delete(frameId);
      pending.outcome.resolve(false);
    }
  }

  private rejectAllPendingDocuments(): void {
    for (const pending of this.pendingDocuments.values()) {
      pending.outcome.resolve(false);
    }
    this.pendingDocuments.clear();
  }

  private rejectAllPreparingDocuments(): void {
    for (const preparing of this.preparingDocuments.values()) {
      preparing.outcome.resolve(false);
    }
    this.preparingDocuments.clear();
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

  private isCurrentPreparing(frameId: number, preparing: PreparingContentDocument): boolean {
    return (
      this.preparingDocuments.get(frameId) === preparing &&
      this.isCurrentRevision(frameId, preparing.revision)
    );
  }

  private matchesNavigationRevision(authorization: ContentNavigationAuthorization): boolean {
    return this.isCurrentRevision(authorization.frameId, {
      epoch: authorization.epoch,
      frameRevision: authorization.frameRevision
    });
  }

  private storeNavigationStart(
    authorization: ContentNavigationAuthorization,
    url: string | undefined,
    source: NavigationStart["source"]
  ): void {
    this.navigationStarts.set(authorization.frameId, {
      authorization,
      source,
      urls: new Set(isNonEmptyString(url) ? [url] : [])
    });
  }

  private toNavigationAuthorization(
    frameId: number,
    revision: AuthorizationRevision
  ): ContentNavigationAuthorization {
    return {
      frameId,
      epoch: revision.epoch,
      frameRevision: revision.frameRevision
    };
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

function sameNavigationAuthorization(
  left: ContentNavigationAuthorization,
  right: ContentNavigationAuthorization
): boolean {
  return (
    left.frameId === right.frameId &&
    left.epoch === right.epoch &&
    left.frameRevision === right.frameRevision
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

function createPreparingAuthorizationOutcome(): PreparingAuthorizationOutcome {
  let resolve!: (allowed: boolean) => void;
  const promise = new Promise<boolean>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
