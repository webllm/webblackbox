import {
  createContentActivationId,
  parseContentActivationId,
  parseContentReadyId,
  type ContentActivationId,
  type ContentReadyId
} from "../shared/content-activation-protocol.js";

export type ContentActivationState = "prepared" | "active" | "draining" | "revoking" | "revoked";

export type ContentActivationIdentity<
  Runtime extends object,
  Fence extends object,
  Mode extends string
> = Readonly<{
  runtime: Runtime;
  fence: Fence;
  sid: string;
  tabId: number;
  frameId: number;
  documentId: string;
  url: string;
  mode: Mode;
}>;

export type ContentActivationParent = Readonly<{
  frameId: number;
  documentId: string;
}>;

export type ContentActivationPreparation<
  Runtime extends object,
  Fence extends object,
  Mode extends string
> = ContentActivationIdentity<Runtime, Fence, Mode> &
  Readonly<{
    readyId: ContentReadyId | string;
    parent?: ContentActivationParent;
  }>;

export type ContentActivationBinding<
  Runtime extends object,
  Fence extends object,
  Mode extends string
> = ContentActivationIdentity<Runtime, Fence, Mode> &
  Readonly<{
    readyId: ContentReadyId;
    activationId: ContentActivationId;
    parent?: ContentActivationParent;
  }>;

export type ContentActivationLookup<
  Runtime extends object,
  Fence extends object,
  Mode extends string
> = ContentActivationIdentity<Runtime, Fence, Mode> &
  Readonly<{
    activationId: ContentActivationId | string;
  }>;

export type ContentActivationSnapshot<
  Runtime extends object,
  Fence extends object,
  Mode extends string
> = ContentActivationBinding<Runtime, Fence, Mode> &
  Readonly<{
    state: ContentActivationState;
    armed: boolean;
  }>;

export type ContentActivationUrlRefresh<
  Runtime extends object,
  Fence extends object,
  Mode extends string
> = Omit<ContentActivationIdentity<Runtime, Fence, Mode>, "url"> &
  Readonly<{
    activationId: ContentActivationId | string;
    url: string;
  }>;

type ActivationRecord<Runtime extends object, Fence extends object, Mode extends string> = {
  binding: ContentActivationBinding<Runtime, Fence, Mode>;
  state: ContentActivationState;
  armed: boolean;
  parentActivationId?: ContentActivationId;
};

const DEFAULT_ACTIVE_STATES = ["active"] as const satisfies readonly ContentActivationState[];
const PORT_BINDABLE_STATES = [
  "prepared",
  "active",
  "draining"
] as const satisfies readonly ContentActivationState[];
const LIVE_STATES = [
  "prepared",
  "active",
  "draining"
] as const satisfies readonly ContentActivationState[];
const ACTIVATION_ID_GENERATION_ATTEMPTS = 8;
const ID_TOMBSTONE_LIMIT = 8_192;

/**
 * Owns two-phase content activation for exact Chrome documents. Every lookup
 * binds both object identities (runtime/fence) and all serialized identity
 * fields, so a restored runtime with the same sid cannot claim prior work.
 */
export class ContentActivationRegistry<
  Runtime extends object,
  Fence extends object,
  Port extends object = object,
  Mode extends string = string
> {
  private readonly byActivationId = new Map<
    ContentActivationId,
    ActivationRecord<Runtime, Fence, Mode>
  >();
  private readonly byReadyId = new Map<ContentReadyId, ActivationRecord<Runtime, Fence, Mode>>();
  private readonly seenActivationIds = new Set<ContentActivationId>();
  private readonly seenReadyIds = new Set<ContentReadyId>();
  private readonly byDocument = new Map<string, ActivationRecord<Runtime, Fence, Mode>>();
  private readonly byRuntime = new Map<Runtime, Set<ActivationRecord<Runtime, Fence, Mode>>>();
  private readonly byPort = new WeakMap<Port, ContentActivationId>();

  public constructor(
    private readonly createActivationId: () => ContentActivationId = createContentActivationId
  ) {}

  public prepare(
    input: ContentActivationPreparation<Runtime, Fence, Mode>
  ): ContentActivationSnapshot<Runtime, Fence, Mode> | null {
    const readyId = parseContentReadyId(input.readyId);

    if (!readyId || !isValidIdentity(input) || !isValidParent(input.parent, input.frameId)) {
      return null;
    }

    const parentRecord = input.frameId > 0 ? this.resolveLiveParent(input) : null;

    if (input.frameId > 0 && !parentRecord) {
      return null;
    }

    const readyRecord = this.byReadyId.get(readyId);

    if (readyRecord) {
      return readyRecord.state !== "revoked" && matchesPreparation(readyRecord.binding, input)
        ? toSnapshot(readyRecord)
        : null;
    }

    if (this.seenReadyIds.has(readyId)) {
      return null;
    }

    const key = toDocumentKey(input);
    const previous = this.byDocument.get(key);

    if (previous) {
      return null;
    }

    const activationId = this.createUniqueActivationId();
    const binding = Object.freeze({
      runtime: input.runtime,
      fence: input.fence,
      sid: input.sid,
      tabId: input.tabId,
      frameId: input.frameId,
      documentId: input.documentId,
      url: input.url,
      mode: input.mode,
      readyId,
      activationId,
      ...(input.parent ? { parent: Object.freeze({ ...input.parent }) } : {})
    }) as ContentActivationBinding<Runtime, Fence, Mode>;
    const record: ActivationRecord<Runtime, Fence, Mode> = {
      binding,
      state: "prepared",
      armed: false,
      ...(parentRecord ? { parentActivationId: parentRecord.binding.activationId } : {})
    };

    this.byActivationId.set(activationId, record);
    this.byReadyId.set(readyId, record);
    addBoundedTombstone(this.seenActivationIds, activationId);
    addBoundedTombstone(this.seenReadyIds, readyId);
    this.byDocument.set(key, record);
    let runtimeRecords = this.byRuntime.get(input.runtime);

    if (!runtimeRecords) {
      runtimeRecords = new Set();
      this.byRuntime.set(input.runtime, runtimeRecords);
    }

    runtimeRecords.add(record);
    return toSnapshot(record);
  }

  public arm(
    binding: ContentActivationBinding<Runtime, Fence, Mode>
  ): ContentActivationSnapshot<Runtime, Fence, Mode> | null {
    const record = this.resolveBinding(binding);

    if (!record || record.state !== "prepared") {
      return null;
    }

    if (!this.hasArmableParent(record)) {
      this.revokeRecord(record);
      return null;
    }

    record.armed = true;
    return toSnapshot(record);
  }

  public activate(
    binding: ContentActivationBinding<Runtime, Fence, Mode>
  ): ContentActivationSnapshot<Runtime, Fence, Mode> | null {
    const record = this.resolveBinding(binding);

    if (!record) {
      return null;
    }

    if (record.state === "active") {
      return toSnapshot(record);
    }

    if (record.state !== "prepared" || !record.armed) {
      return null;
    }

    if (!this.hasActiveParent(record)) {
      this.revokeRecord(record);
      return null;
    }

    record.state = "active";
    return toSnapshot(record);
  }

  public drain(
    binding: ContentActivationBinding<Runtime, Fence, Mode>
  ): ContentActivationSnapshot<Runtime, Fence, Mode> | null {
    const record = this.resolveBinding(binding);

    if (!record) {
      return null;
    }

    if (record.state === "draining") {
      return toSnapshot(record);
    }

    if (record.state !== "active") {
      return null;
    }

    record.state = "draining";
    return toSnapshot(record);
  }

  /**
   * Closes every ordinary registry admission while retaining the exact binding
   * long enough for the service worker to deactivate its MAIN-world controller.
   */
  public beginRevocation(
    binding: ContentActivationBinding<Runtime, Fence, Mode>
  ): ContentActivationSnapshot<Runtime, Fence, Mode> | null {
    const record = this.resolveBinding(binding, true);

    if (!record || record.state === "revoked") {
      return null;
    }

    if (record.state !== "revoking") {
      record.state = "revoking";
      record.armed = false;
    }

    return toSnapshot(record);
  }

  /** Removes one deactivated binding only after every descendant has also left the registry. */
  public finalizeRevocation(binding: ContentActivationBinding<Runtime, Fence, Mode>): boolean {
    const record = this.resolveBinding(binding, true);
    if (!record || record.state !== "revoking") {
      return false;
    }

    const runtimeRecords = this.byRuntime.get(record.binding.runtime);
    if (
      [...(runtimeRecords ?? [])].some(
        (child) =>
          child !== record &&
          child.state !== "revoked" &&
          child.parentActivationId === record.binding.activationId
      )
    ) {
      return false;
    }

    this.removeRecord(record);
    return true;
  }

  public revoke(binding: ContentActivationBinding<Runtime, Fence, Mode>): boolean {
    const record = this.resolveBinding(binding, true);

    if (!record || record.state === "revoked") {
      return false;
    }

    return this.revokeRecord(record) > 0;
  }

  public revokeDocument(identity: ContentActivationIdentity<Runtime, Fence, Mode>): boolean {
    if (!isValidIdentity(identity)) {
      return false;
    }

    const record = this.byDocument.get(toDocumentKey(identity));

    if (!record || !matchesIdentity(record.binding, identity)) {
      return false;
    }

    return this.revokeRecord(record) > 0;
  }

  public revokeRuntime(runtime: Runtime, fence?: Fence): number {
    const records = this.byRuntime.get(runtime);

    if (!records) {
      return 0;
    }

    let revoked = 0;

    for (const record of [...records]) {
      if (record.state === "revoked" || (fence !== undefined && record.binding.fence !== fence)) {
        continue;
      }

      revoked += this.revokeRecord(record);
    }

    return revoked;
  }

  public revokeParent(identity: ContentActivationIdentity<Runtime, Fence, Mode>): number {
    if (!isValidIdentity(identity)) {
      return 0;
    }

    const parent = this.byDocument.get(toDocumentKey(identity));

    if (!parent || !matchesIdentity(parent.binding, identity)) {
      return 0;
    }

    return this.revokeRecord(parent);
  }

  public refreshUrl(
    input: ContentActivationUrlRefresh<Runtime, Fence, Mode>
  ): ContentActivationSnapshot<Runtime, Fence, Mode> | null {
    const activationId = parseContentActivationId(input.activationId);

    if (!activationId || !isValidIdentity(input)) {
      return null;
    }

    const record = this.byActivationId.get(activationId);

    if (
      !record ||
      record.state === "revoked" ||
      this.byDocument.get(toDocumentKey(input)) !== record ||
      !matchesStableIdentity(record.binding, input)
    ) {
      return null;
    }

    record.binding = Object.freeze({
      ...record.binding,
      url: input.url
    });
    return toSnapshot(record);
  }

  public lookupByReadyId(
    value: ContentReadyId | string,
    allowedStates: readonly ContentActivationState[] = LIVE_STATES
  ): ContentActivationSnapshot<Runtime, Fence, Mode> | null {
    const readyId = parseContentReadyId(value);
    const record = readyId ? this.byReadyId.get(readyId) : undefined;
    return record && allowedStates.includes(record.state) ? toSnapshot(record) : null;
  }

  public lookupByActivationId(
    value: ContentActivationId | string,
    allowedStates: readonly ContentActivationState[] = LIVE_STATES
  ): ContentActivationSnapshot<Runtime, Fence, Mode> | null {
    const activationId = parseContentActivationId(value);
    const record = activationId ? this.byActivationId.get(activationId) : undefined;
    return record && allowedStates.includes(record.state) ? toSnapshot(record) : null;
  }

  public listRuntime(
    runtime: Runtime,
    fence?: Fence,
    allowedStates: readonly ContentActivationState[] = LIVE_STATES
  ): ContentActivationSnapshot<Runtime, Fence, Mode>[] {
    const records = this.byRuntime.get(runtime);

    if (!records) {
      return [];
    }

    return [...records]
      .filter(
        (record) =>
          (fence === undefined || record.binding.fence === fence) &&
          allowedStates.includes(record.state)
      )
      .map(toSnapshot);
  }

  public validate(
    input: ContentActivationLookup<Runtime, Fence, Mode>,
    allowedStates: readonly ContentActivationState[] = DEFAULT_ACTIVE_STATES
  ): ContentActivationSnapshot<Runtime, Fence, Mode> | null {
    const record = this.resolveLookup(input);
    return record && allowedStates.includes(record.state) ? toSnapshot(record) : null;
  }

  public currentForDocument(
    identity: ContentActivationIdentity<Runtime, Fence, Mode>,
    allowedStates: readonly ContentActivationState[] = LIVE_STATES
  ): ContentActivationSnapshot<Runtime, Fence, Mode> | null {
    if (!isValidIdentity(identity)) {
      return null;
    }

    const record = this.byDocument.get(toDocumentKey(identity));
    return record &&
      matchesIdentity(record.binding, identity) &&
      allowedStates.includes(record.state)
      ? toSnapshot(record)
      : null;
  }

  public bindPort(port: Port, binding: ContentActivationBinding<Runtime, Fence, Mode>): boolean {
    const record = this.resolveBinding(binding);

    if (
      !isObject(port) ||
      !record ||
      !PORT_BINDABLE_STATES.includes(record.state as "prepared" | "active" | "draining")
    ) {
      return false;
    }

    this.byPort.set(port, record.binding.activationId);
    return true;
  }

  public validatePort(
    port: Port,
    input: ContentActivationLookup<Runtime, Fence, Mode>,
    allowedStates: readonly ContentActivationState[] = DEFAULT_ACTIVE_STATES
  ): ContentActivationSnapshot<Runtime, Fence, Mode> | null {
    if (!isObject(port)) {
      return null;
    }

    const record = this.resolveLookup(input);

    return record &&
      this.byPort.get(port) === record.binding.activationId &&
      allowedStates.includes(record.state)
      ? toSnapshot(record)
      : null;
  }

  public unbindPort(port: Port, binding?: ContentActivationBinding<Runtime, Fence, Mode>): boolean {
    if (!isObject(port)) {
      return false;
    }

    const activationId = this.byPort.get(port);

    if (!activationId || (binding && activationId !== binding.activationId)) {
      return false;
    }

    return this.byPort.delete(port);
  }

  private resolveLookup(
    input: ContentActivationLookup<Runtime, Fence, Mode>
  ): ActivationRecord<Runtime, Fence, Mode> | null {
    if (!isValidIdentity(input)) {
      return null;
    }

    const activationId = parseContentActivationId(input.activationId);

    if (!activationId) {
      return null;
    }

    const record = this.byActivationId.get(activationId);
    return record && matchesIdentity(record.binding, input) ? record : null;
  }

  private resolveBinding(
    binding: ContentActivationBinding<Runtime, Fence, Mode>,
    includeRevoked = false
  ): ActivationRecord<Runtime, Fence, Mode> | null {
    if (!isValidIdentity(binding)) {
      return null;
    }

    const activationId = parseContentActivationId(binding.activationId);
    const readyId = parseContentReadyId(binding.readyId);

    if (!activationId || !readyId) {
      return null;
    }

    const record = this.byActivationId.get(activationId);

    if (
      !record ||
      (!includeRevoked && record.state === "revoked") ||
      !matchesBinding(record.binding, { ...binding, activationId, readyId })
    ) {
      return null;
    }

    return record;
  }

  private createUniqueActivationId(): ContentActivationId {
    for (let attempt = 0; attempt < ACTIVATION_ID_GENERATION_ATTEMPTS; attempt += 1) {
      const activationId = parseContentActivationId(this.createActivationId());

      if (!activationId) {
        throw new Error("Content activation id factory returned an invalid id.");
      }

      if (!this.seenActivationIds.has(activationId) && !this.byActivationId.has(activationId)) {
        return activationId;
      }
    }

    throw new Error("Unable to allocate a unique content activation id.");
  }

  private resolveLiveParent(
    input: ContentActivationPreparation<Runtime, Fence, Mode>
  ): ActivationRecord<Runtime, Fence, Mode> | null {
    const parent = input.parent;

    if (!parent) {
      return null;
    }

    const record = this.byDocument.get(
      toDocumentKey({ tabId: input.tabId, frameId: parent.frameId, documentId: parent.documentId })
    );

    if (
      !record ||
      record.state === "revoked" ||
      !record.armed ||
      !matchesRuntimeTreeIdentity(record.binding, input)
    ) {
      return null;
    }

    const visited = new Set<ActivationRecord<Runtime, Fence, Mode>>();
    let current: ActivationRecord<Runtime, Fence, Mode> | undefined = record;

    while (current && !visited.has(current)) {
      visited.add(current);
      if (
        current.binding.frameId === input.frameId &&
        current.binding.documentId === input.documentId
      ) {
        return null;
      }

      const ancestor: ContentActivationParent | undefined = current.binding.parent;
      current = ancestor
        ? this.byDocument.get(
            toDocumentKey({
              tabId: input.tabId,
              frameId: ancestor.frameId,
              documentId: ancestor.documentId
            })
          )
        : undefined;
    }

    return current ? null : record;
  }

  private hasArmableParent(record: ActivationRecord<Runtime, Fence, Mode>): boolean {
    if (record.binding.frameId === 0) {
      return record.parentActivationId === undefined;
    }

    const parent = record.parentActivationId
      ? this.byActivationId.get(record.parentActivationId)
      : undefined;
    return Boolean(
      parent &&
      parent.binding.runtime === record.binding.runtime &&
      parent.binding.fence === record.binding.fence &&
      parent.armed &&
      (parent.state === "prepared" || parent.state === "active")
    );
  }

  private hasActiveParent(record: ActivationRecord<Runtime, Fence, Mode>): boolean {
    if (record.binding.frameId === 0) {
      return record.parentActivationId === undefined;
    }

    const parent = record.parentActivationId
      ? this.byActivationId.get(record.parentActivationId)
      : undefined;
    return Boolean(
      parent &&
      parent.binding.runtime === record.binding.runtime &&
      parent.binding.fence === record.binding.fence &&
      parent.state === "active"
    );
  }

  private revokeRecord(record: ActivationRecord<Runtime, Fence, Mode>): number {
    if (record.state === "revoked") {
      return 0;
    }

    let revoked = 1;
    const runtimeRecords = this.byRuntime.get(record.binding.runtime);
    for (const child of [...(runtimeRecords ?? [])]) {
      if (
        child !== record &&
        child.state !== "revoked" &&
        child.parentActivationId === record.binding.activationId
      ) {
        revoked += this.revokeRecord(child);
      }
    }

    this.removeRecord(record);
    return revoked;
  }

  private removeRecord(record: ActivationRecord<Runtime, Fence, Mode>): void {
    const runtimeRecords = this.byRuntime.get(record.binding.runtime);
    record.state = "revoked";
    record.armed = false;
    if (this.byActivationId.get(record.binding.activationId) === record) {
      this.byActivationId.delete(record.binding.activationId);
    }
    if (this.byReadyId.get(record.binding.readyId) === record) {
      this.byReadyId.delete(record.binding.readyId);
    }
    const key = toDocumentKey(record.binding);

    if (this.byDocument.get(key) === record) {
      this.byDocument.delete(key);
    }

    runtimeRecords?.delete(record);

    if (runtimeRecords?.size === 0) {
      this.byRuntime.delete(record.binding.runtime);
    }
  }
}

function isValidIdentity<Runtime extends object, Fence extends object, Mode extends string>(
  input: ContentActivationIdentity<Runtime, Fence, Mode>
): boolean {
  return (
    isObject(input.runtime) &&
    isObject(input.fence) &&
    isNonEmptyString(input.sid) &&
    Number.isSafeInteger(input.tabId) &&
    input.tabId >= 0 &&
    Number.isSafeInteger(input.frameId) &&
    input.frameId >= 0 &&
    isNonEmptyString(input.documentId) &&
    isNonEmptyString(input.url) &&
    isNonEmptyString(input.mode)
  );
}

function matchesIdentity<Runtime extends object, Fence extends object, Mode extends string>(
  expected: ContentActivationIdentity<Runtime, Fence, Mode>,
  actual: ContentActivationIdentity<Runtime, Fence, Mode>
): boolean {
  return (
    expected.runtime === actual.runtime &&
    expected.fence === actual.fence &&
    expected.sid === actual.sid &&
    expected.tabId === actual.tabId &&
    expected.frameId === actual.frameId &&
    expected.documentId === actual.documentId &&
    expected.url === actual.url &&
    expected.mode === actual.mode
  );
}

function matchesBinding<Runtime extends object, Fence extends object, Mode extends string>(
  expected: ContentActivationBinding<Runtime, Fence, Mode>,
  actual: ContentActivationBinding<Runtime, Fence, Mode>
): boolean {
  return (
    matchesIdentity(expected, actual) &&
    expected.readyId === actual.readyId &&
    expected.activationId === actual.activationId &&
    matchesParent(expected.parent, actual.parent)
  );
}

function matchesPreparation<Runtime extends object, Fence extends object, Mode extends string>(
  expected: ContentActivationBinding<Runtime, Fence, Mode>,
  actual: ContentActivationPreparation<Runtime, Fence, Mode>
): boolean {
  return matchesIdentity(expected, actual) && matchesParent(expected.parent, actual.parent);
}

function matchesParent(
  expected: ContentActivationParent | undefined,
  actual: ContentActivationParent | undefined
): boolean {
  return (
    expected === actual ||
    (expected !== undefined &&
      actual !== undefined &&
      expected.frameId === actual.frameId &&
      expected.documentId === actual.documentId)
  );
}

function matchesStableIdentity<Runtime extends object, Fence extends object, Mode extends string>(
  expected: ContentActivationIdentity<Runtime, Fence, Mode>,
  actual: Omit<ContentActivationIdentity<Runtime, Fence, Mode>, "url">
): boolean {
  return (
    expected.runtime === actual.runtime &&
    expected.fence === actual.fence &&
    expected.sid === actual.sid &&
    expected.tabId === actual.tabId &&
    expected.frameId === actual.frameId &&
    expected.documentId === actual.documentId &&
    expected.mode === actual.mode
  );
}

function matchesRuntimeTreeIdentity<
  Runtime extends object,
  Fence extends object,
  Mode extends string
>(
  candidate: ContentActivationIdentity<Runtime, Fence, Mode>,
  root: ContentActivationIdentity<Runtime, Fence, Mode>
): boolean {
  return (
    candidate.runtime === root.runtime &&
    candidate.fence === root.fence &&
    candidate.sid === root.sid &&
    candidate.tabId === root.tabId &&
    candidate.mode === root.mode
  );
}

function toDocumentKey(input: { tabId: number; frameId: number; documentId: string }): string {
  return JSON.stringify([input.tabId, input.frameId, input.documentId]);
}

function toSnapshot<Runtime extends object, Fence extends object, Mode extends string>(
  record: ActivationRecord<Runtime, Fence, Mode>
): ContentActivationSnapshot<Runtime, Fence, Mode> {
  return Object.freeze({
    ...record.binding,
    state: record.state,
    armed: record.armed
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidParent(parent: ContentActivationParent | undefined, frameId: number): boolean {
  if (frameId === 0) {
    return parent === undefined;
  }

  return (
    parent !== undefined &&
    Number.isSafeInteger(parent.frameId) &&
    parent.frameId >= 0 &&
    parent.frameId !== frameId &&
    isNonEmptyString(parent.documentId)
  );
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function addBoundedTombstone<Value>(tombstones: Set<Value>, value: Value): void {
  tombstones.delete(value);
  tombstones.add(value);

  while (tombstones.size > ID_TOMBSTONE_LIMIT) {
    const oldest = tombstones.values().next().value as Value | undefined;
    if (oldest === undefined) {
      break;
    }
    tombstones.delete(oldest);
  }
}
