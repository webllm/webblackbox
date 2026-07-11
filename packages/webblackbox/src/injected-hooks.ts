import {
  capturePolicySchema,
  DEFAULT_CAPTURE_POLICY,
  sanitizeUrlForPrivacy,
  type CapturePolicy
} from "@webblackbox/protocol";

type CapturePayload = Record<string, unknown>;

const DEFAULT_FLAG = "__WEBBLACKBOX_INJECTED__";
const NETWORK_BODY_CAPTURE_DEFAULT_MAX_BYTES = 128 * 1024;
const NETWORK_BODY_CAPTURE_MAX_PER_MINUTE = 45;
const NETWORK_BODY_CAPTURE_MAX_BYTES_PER_MINUTE = 4 * 1024 * 1024;
const NOISY_CONSOLE_MAX_PER_SEC = 40;
const NOISY_CONSOLE_METHODS = new Set(["log", "info", "debug", "dir", "dirxml", "table"]);
const SAFE_SERIALIZE_MAX_DEPTH = 3;
const SAFE_SERIALIZE_MAX_PROPERTIES = 24;
const SAFE_SERIALIZE_MAX_STRING_CHARS = 1_200;
const EMIT_FLUSH_MAX_EVENTS = 24;
const INJECTED_MESSAGE_MAX_PAYLOAD_CHARS = 4 * 1024 * 1024 + 256 * 1024;
const INJECTED_MESSAGE_MAX_NODES = 512;
const INJECTED_MESSAGE_MAX_DEPTH = 6;
const INJECTED_MESSAGE_MAX_COLLECTION_ITEMS = 64;
const INJECTED_ACTIVATION_ID_PATTERN = /^a1_[0-9a-f]{64}$/;
const INJECTED_CONTROL_SECRET_PATTERN = /^[0-9a-f]{64}$/;
const INJECTED_CONTROL_NONCE_PATTERN = /^n1_[0-9a-f]{64}$/;
const INJECTED_CONTROL_PROOF_PATTERN = /^[0-9a-f]{64}$/;
const INJECTED_CONTROL_RANDOM_BYTES = 32;
const INJECTED_CONTROL_SEEN_NONCES_MAX = 512;
const INJECTED_DIRECT_REPLAY_EVENT_LIMIT = 256;
const INJECTED_DIRECT_REPLAY_BYTE_LIMIT = 1024 * 1024;
const INJECTED_DIRECT_REPLAY_BYTE_LIMIT_MAX = 16 * 1024 * 1024;
const INJECTED_DIRECT_MAX_REVISION = 9_007_199_254_740_991;
const NETWORK_HEADER_ALLOWLIST = new Set([
  "accept",
  "accept-language",
  "cache-control",
  "content-encoding",
  "content-language",
  "content-length",
  "content-type",
  "etag",
  "expires",
  "last-modified",
  "pragma",
  "vary"
]);

/** `window.postMessage` source tag used by injected lite capture hooks. */
export const INJECTED_MESSAGE_SOURCE = "webblackbox-injected";

/** DOM event used to push runtime capture config into the injected page world. */
export const INJECTED_CAPTURE_CONFIG_EVENT = "webblackbox:injected-config";
export const INJECTED_CAPTURE_DRAIN_EVENT = "webblackbox:injected-drain";

export type InjectedCaptureConfig = {
  active: boolean;
  activationId: string;
  bodyCaptureMaxBytes?: number;
  capturePolicy?: CapturePolicy;
};

export type AuthenticatedInjectedCaptureConfig = InjectedCaptureConfig & {
  nonce: string;
  proof: string;
};

export type AuthenticatedInjectedCaptureDrainRequest = {
  activationId: string;
  nonce: string;
  proof: string;
};

export type AuthenticatedInjectedCaptureControlAck = {
  source: typeof INJECTED_MESSAGE_SOURCE;
  kind: "injected-armed-authenticated" | "injected-drained-authenticated";
  activationId: string;
  nonce: string;
  proof: string;
};

export type InjectedCaptureEvent = {
  activationId: string;
  /** Privileged direct-controller sequence. Legacy standalone events omit it. */
  seq?: number;
  rawType: string;
  payload: CapturePayload;
  t: number;
  mono: number;
};

export type InjectedDirectCaptureEvent = InjectedCaptureEvent & {
  seq: number;
};

export type InjectedDirectCommand =
  | {
      kind: "probe";
    }
  | {
      kind: "activate";
      revision: number;
      config: InjectedCaptureConfig;
    }
  | {
      kind: "deactivate" | "drain";
      revision: number;
      activationId: string;
    };

export type InjectedDirectControllerPhase = "inactive" | "active" | "drained";

export type InjectedDirectBootstrapResult =
  | {
      kind: "installed" | "existing";
      phase: InjectedDirectControllerPhase;
      revision: number;
    }
  | {
      kind: "rejected" | "unavailable";
    };

export type InjectedDirectDrainResult = {
  kind: "drained";
  activationId: string;
  revision: number;
  events: InjectedDirectCaptureEvent[];
  producedThrough: number;
  /** Highest sequence no longer retained; `0` means the replay window is complete. */
  truncatedBefore: number;
  degraded: boolean;
  replayed: boolean;
};

export type InjectedDirectControlResult =
  | {
      kind: "probed";
      phase: InjectedDirectControllerPhase;
      revision: number;
      activationId: string | null;
      producedThrough: number;
      truncatedBefore: number;
    }
  | {
      kind: "activated" | "deactivated";
      activationId: string;
      revision: number;
    }
  | InjectedDirectDrainResult
  | {
      kind: "rejected";
      reason: "activation-mismatch" | "capability" | "invalid-command" | "stale";
    }
  | {
      kind: "unavailable";
    };

/** Message contract emitted by injected hooks into the page window. */
export type InjectedCaptureWindowMessage =
  | {
      source: typeof INJECTED_MESSAGE_SOURCE;
      kind: "capture-event";
      activationId: string;
      seq?: number;
      rawType: string;
      payload: CapturePayload;
      t: number;
      mono: number;
    }
  | {
      source: typeof INJECTED_MESSAGE_SOURCE;
      kind: "capture-events";
      activationId: string;
      events: InjectedCaptureEvent[];
    };

export type InjectedCaptureArmedMessage = {
  source: typeof INJECTED_MESSAGE_SOURCE;
  kind: "injected-armed";
  activationId: string;
};

export type InjectedCaptureDrainedMessage = {
  source: typeof INJECTED_MESSAGE_SOURCE;
  kind: "injected-drained";
  activationId: string;
};

const INJECTED_CAPTURE_RAW_TYPES = new Set([
  "console",
  "fetch",
  "fetchError",
  "indexedDbOp",
  "localStorageOp",
  "networkBody",
  "pageError",
  "privacyViolation",
  "resourceError",
  "sessionStorageOp",
  "sse",
  "unhandledrejection",
  "xhr"
]);

/**
 * Treats MAIN-world messages as hostile page input. This parser intentionally
 * accepts observations only; it never exposes extension control operations.
 */
export function parseInjectedCaptureWindowMessage(value: unknown): InjectedCaptureEvent[] | null {
  try {
    return parseInjectedCaptureWindowMessageUnchecked(value);
  } catch {
    return null;
  }
}

function parseInjectedCaptureWindowMessageUnchecked(value: unknown): InjectedCaptureEvent[] | null {
  const message = asPlainRecord(value);

  if (
    !message ||
    message.source !== INJECTED_MESSAGE_SOURCE ||
    !isInjectedActivationId(message.activationId)
  ) {
    return null;
  }

  const candidates = parseInjectedMessageCandidates(message);

  if (!candidates || candidates.length === 0 || candidates.length > EMIT_FLUSH_MAX_EVENTS) {
    return null;
  }

  const budget = {
    nodes: 0,
    chars: 0
  };
  const events: InjectedCaptureEvent[] = [];

  for (const candidate of candidates) {
    const event = asPlainRecord(candidate);
    const payload = asPlainRecord(event?.payload);

    if (
      !event ||
      !hasExactKeys(event, ["activationId", "seq", "rawType", "payload", "t", "mono"]) ||
      event.activationId !== message.activationId ||
      (event.seq !== undefined && !isInjectedDirectSequence(event.seq)) ||
      typeof event.rawType !== "string" ||
      !INJECTED_CAPTURE_RAW_TYPES.has(event.rawType) ||
      !payload ||
      typeof event.t !== "number" ||
      !Number.isFinite(event.t) ||
      typeof event.mono !== "number" ||
      !Number.isFinite(event.mono) ||
      !isBoundedInjectedValue(payload, 0, budget)
    ) {
      return null;
    }

    const safePayload = asPlainRecord(structuredClone(payload));
    if (!safePayload) {
      return null;
    }

    events.push({
      activationId: message.activationId,
      ...(event.seq === undefined ? {} : { seq: event.seq }),
      rawType: event.rawType,
      payload: safePayload,
      t: event.t,
      mono: event.mono
    });
  }

  return events;
}

/** Strictly parses the MAIN-world acknowledgement for one exact activation. */
export function parseInjectedCaptureArmedMessage(value: unknown): string | null {
  try {
    const message = asPlainRecord(value);

    return message &&
      hasExactKeys(message, ["source", "kind", "activationId"]) &&
      message.source === INJECTED_MESSAGE_SOURCE &&
      message.kind === "injected-armed" &&
      isInjectedActivationId(message.activationId)
      ? message.activationId
      : null;
  } catch {
    return null;
  }
}

/** Strictly parses the close-only MAIN-world drain barrier. */
export function parseInjectedCaptureDrainedMessage(value: unknown): string | null {
  try {
    const message = asPlainRecord(value);

    return message &&
      hasExactKeys(message, ["source", "kind", "activationId"]) &&
      message.source === INJECTED_MESSAGE_SOURCE &&
      message.kind === "injected-drained" &&
      isInjectedActivationId(message.activationId)
      ? message.activationId
      : null;
  } catch {
    return null;
  }
}

/** Strictly parses capture-control state before it reaches MAIN-world hooks. */
export function parseInjectedCaptureConfig(value: unknown): InjectedCaptureConfig | null {
  try {
    const config = asPlainRecord(value);

    if (
      !config ||
      !hasExactKeys(config, ["active", "activationId", "bodyCaptureMaxBytes", "capturePolicy"]) ||
      typeof config.active !== "boolean" ||
      !isInjectedActivationId(config.activationId) ||
      (config.bodyCaptureMaxBytes !== undefined &&
        (typeof config.bodyCaptureMaxBytes !== "number" ||
          !Number.isFinite(config.bodyCaptureMaxBytes) ||
          config.bodyCaptureMaxBytes < 0))
    ) {
      return null;
    }

    const policy =
      config.capturePolicy === undefined
        ? undefined
        : capturePolicySchema.safeParse(config.capturePolicy);

    if (policy && !policy.success) {
      return null;
    }

    return {
      active: config.active,
      activationId: config.activationId,
      ...(config.bodyCaptureMaxBytes === undefined
        ? {}
        : { bodyCaptureMaxBytes: config.bodyCaptureMaxBytes }),
      ...(policy === undefined ? {} : { capturePolicy: policy.data })
    };
  } catch {
    return null;
  }
}

/** Returns true only for versioned, fixed-width activation identities. */
export function isInjectedActivationId(value: unknown): value is string {
  return typeof value === "string" && INJECTED_ACTIVATION_ID_PATTERN.test(value);
}

/** Creates a document-scoped control key that must travel only over extension-owned channels. */
export function createInjectedControlSecret(): string {
  return createInjectedControlRandomHex("");
}

export async function createAuthenticatedInjectedCaptureConfig(
  secret: string,
  config: InjectedCaptureConfig
): Promise<AuthenticatedInjectedCaptureConfig> {
  const parsed = parseInjectedCaptureConfig(config);
  if (!parsed || !isInjectedControlSecret(secret)) {
    throw new Error("Invalid injected capture control config or secret.");
  }

  const nonce = createInjectedControlRandomHex("n1_");
  const proof = await signInjectedControlPayload(
    secret,
    serializeInjectedConfigControl("request", parsed, nonce)
  );
  return { ...parsed, nonce, proof };
}

export async function createAuthenticatedInjectedCaptureDrainRequest(
  secret: string,
  activationId: string
): Promise<AuthenticatedInjectedCaptureDrainRequest> {
  if (!isInjectedControlSecret(secret) || !isInjectedActivationId(activationId)) {
    throw new Error("Invalid injected drain control identity.");
  }

  const nonce = createInjectedControlRandomHex("n1_");
  return {
    activationId,
    nonce,
    proof: await signInjectedControlPayload(
      secret,
      serializeInjectedDrainControl("request", activationId, nonce)
    )
  };
}

export async function verifyAuthenticatedInjectedCaptureControlAck(
  value: unknown,
  secret: string,
  expected: {
    kind: AuthenticatedInjectedCaptureControlAck["kind"];
    activationId: string;
    nonce: string;
  }
): Promise<boolean> {
  const message = parseAuthenticatedInjectedCaptureControlAck(value);
  if (
    !message ||
    !isInjectedControlSecret(secret) ||
    message.kind !== expected.kind ||
    message.activationId !== expected.activationId ||
    message.nonce !== expected.nonce
  ) {
    return false;
  }

  const direction = message.kind === "injected-armed-authenticated" ? "armed" : "drained";
  return verifyInjectedControlPayload(
    secret,
    serializeInjectedDrainControl(direction, message.activationId, message.nonce),
    message.proof
  );
}

function isInjectedControlSecret(value: unknown): value is string {
  return typeof value === "string" && INJECTED_CONTROL_SECRET_PATTERN.test(value);
}

function isInjectedControlNonce(value: unknown): value is string {
  return typeof value === "string" && INJECTED_CONTROL_NONCE_PATTERN.test(value);
}

function createInjectedControlRandomHex(prefix: "" | "n1_"): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Cryptographic randomness is unavailable for injected capture control.");
  }

  const bytes = new Uint8Array(INJECTED_CONTROL_RANDOM_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}${bytesToHex(bytes)}`;
}

function parseAuthenticatedInjectedCaptureConfig(
  value: unknown
): AuthenticatedInjectedCaptureConfig | null {
  const message = asPlainRecord(value);
  if (
    !message ||
    !hasAllExactKeys(message, [
      "active",
      "activationId",
      "bodyCaptureMaxBytes",
      "capturePolicy",
      "nonce",
      "proof"
    ]) ||
    !isInjectedControlNonce(message.nonce) ||
    typeof message.proof !== "string" ||
    !INJECTED_CONTROL_PROOF_PATTERN.test(message.proof)
  ) {
    return null;
  }

  const config = parseInjectedCaptureConfig({
    active: message.active,
    activationId: message.activationId,
    bodyCaptureMaxBytes: message.bodyCaptureMaxBytes,
    capturePolicy: message.capturePolicy
  });
  return config ? { ...config, nonce: message.nonce, proof: message.proof } : null;
}

function parseAuthenticatedInjectedCaptureDrainRequest(
  value: unknown
): AuthenticatedInjectedCaptureDrainRequest | null {
  const message = asPlainRecord(value);
  return message &&
    hasAllExactKeys(message, ["activationId", "nonce", "proof"]) &&
    isInjectedActivationId(message.activationId) &&
    isInjectedControlNonce(message.nonce) &&
    typeof message.proof === "string" &&
    INJECTED_CONTROL_PROOF_PATTERN.test(message.proof)
    ? {
        activationId: message.activationId,
        nonce: message.nonce,
        proof: message.proof
      }
    : null;
}

function parseAuthenticatedInjectedCaptureControlAck(
  value: unknown
): AuthenticatedInjectedCaptureControlAck | null {
  const message = asPlainRecord(value);
  return message &&
    hasAllExactKeys(message, ["source", "kind", "activationId", "nonce", "proof"]) &&
    message.source === INJECTED_MESSAGE_SOURCE &&
    (message.kind === "injected-armed-authenticated" ||
      message.kind === "injected-drained-authenticated") &&
    isInjectedActivationId(message.activationId) &&
    isInjectedControlNonce(message.nonce) &&
    typeof message.proof === "string" &&
    INJECTED_CONTROL_PROOF_PATTERN.test(message.proof)
    ? {
        source: INJECTED_MESSAGE_SOURCE,
        kind: message.kind,
        activationId: message.activationId,
        nonce: message.nonce,
        proof: message.proof
      }
    : null;
}

function serializeInjectedConfigControl(
  direction: "request",
  config: InjectedCaptureConfig,
  nonce: string
): string {
  return JSON.stringify([
    "webblackbox-injected-control-v1",
    direction,
    "config",
    config.activationId,
    nonce,
    config.active,
    config.bodyCaptureMaxBytes ?? null,
    canonicalizeInjectedControlValue(config.capturePolicy ?? null)
  ]);
}

function serializeInjectedDrainControl(
  direction: "request" | "armed" | "drained",
  activationId: string,
  nonce: string
): string {
  return JSON.stringify(["webblackbox-injected-control-v1", direction, activationId, nonce]);
}

function canonicalizeInjectedControlValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeInjectedControlValue);
  }
  const record = asPlainRecord(value);
  if (record) {
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalizeInjectedControlValue(record[key])])
    );
  }
  return value;
}

async function signInjectedControlPayload(secret: string, payload: string): Promise<string> {
  const cryptoApi = requireInjectedControlCrypto();
  const key = await cryptoApi.subtle.importKey(
    "raw",
    toInjectedControlArrayBuffer(hexToBytes(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await cryptoApi.subtle.sign(
    "HMAC",
    key,
    toInjectedControlArrayBuffer(new TextEncoder().encode(payload))
  );
  return bytesToHex(new Uint8Array(signature));
}

async function verifyInjectedControlPayload(
  secret: string,
  payload: string,
  proof: string
): Promise<boolean> {
  if (!isInjectedControlSecret(secret) || !INJECTED_CONTROL_PROOF_PATTERN.test(proof)) {
    return false;
  }
  try {
    const cryptoApi = requireInjectedControlCrypto();
    const key = await cryptoApi.subtle.importKey(
      "raw",
      toInjectedControlArrayBuffer(hexToBytes(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    return cryptoApi.subtle.verify(
      "HMAC",
      key,
      toInjectedControlArrayBuffer(hexToBytes(proof)),
      toInjectedControlArrayBuffer(new TextEncoder().encode(payload))
    );
  } catch {
    return false;
  }
}

function requireInjectedControlCrypto(): Crypto {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) {
    throw new Error("Web Crypto is unavailable for injected capture control.");
  }
  return cryptoApi;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toInjectedControlArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function createInjectedActivationId(): string | null {
  if (!globalThis.crypto?.getRandomValues) {
    return null;
  }

  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `a1_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function parseInjectedMessageCandidates(message: Record<string, unknown>): unknown[] | null {
  if (message.kind === "capture-event") {
    if (
      !hasExactKeys(message, [
        "source",
        "kind",
        "activationId",
        "seq",
        "rawType",
        "payload",
        "t",
        "mono"
      ])
    ) {
      return null;
    }

    return [
      {
        activationId: message.activationId,
        seq: message.seq,
        rawType: message.rawType,
        payload: message.payload,
        t: message.t,
        mono: message.mono
      }
    ];
  }

  if (
    message.kind !== "capture-events" ||
    !hasExactKeys(message, ["source", "kind", "activationId", "events"]) ||
    !Array.isArray(message.events)
  ) {
    return null;
  }

  return message.events;
}

function isInjectedDirectSequence(value: unknown): value is number {
  return (
    typeof value === "number" &&
    value > 0 &&
    value <= INJECTED_DIRECT_MAX_REVISION &&
    value % 1 === 0
  );
}

function isBoundedInjectedValue(
  value: unknown,
  depth: number,
  budget: { nodes: number; chars: number }
): boolean {
  budget.nodes += 1;
  if (budget.nodes > INJECTED_MESSAGE_MAX_NODES || depth > INJECTED_MESSAGE_MAX_DEPTH) {
    return false;
  }

  if (value === null || value === undefined || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (typeof value === "string") {
    budget.chars += value.length;
    return budget.chars <= INJECTED_MESSAGE_MAX_PAYLOAD_CHARS;
  }

  if (Array.isArray(value)) {
    return (
      value.length <= INJECTED_MESSAGE_MAX_COLLECTION_ITEMS &&
      value.every((entry) => isBoundedInjectedValue(entry, depth + 1, budget))
    );
  }

  const record = asPlainRecord(value);
  if (!record) {
    return false;
  }

  const entries = Object.entries(record);
  if (entries.length > INJECTED_MESSAGE_MAX_COLLECTION_ITEMS) {
    return false;
  }

  for (const [key, entry] of entries) {
    if (key.length > 128 || key === "__proto__" || key === "constructor" || key === "prototype") {
      return false;
    }
    budget.chars += key.length;
    if (
      budget.chars > INJECTED_MESSAGE_MAX_PAYLOAD_CHARS ||
      !isBoundedInjectedValue(entry, depth + 1, budget)
    ) {
      return false;
    }
  }

  return true;
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(record: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function hasAllExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[]
): boolean {
  return Object.keys(record).length === expectedKeys.length && hasExactKeys(record, expectedKeys);
}

function cloneInjectedControlDetail(value: unknown): unknown | null {
  try {
    return structuredClone(value);
  } catch {
    return null;
  }
}

/** Options for installing browser-side injected hooks. */
export type InjectedHooksOptions = {
  /** Global flag name used to prevent duplicate hook installation. */
  flag?: string;
  /** Enables event emission after hooks are installed. */
  active?: boolean;
  /** Exact activation identity attached to every MAIN-world observation. */
  activationId?: string;
  /** Per-response capture budget; `0` disables response-body sampling. */
  bodyCaptureMaxBytes?: number;
  /** Active capture policy used to keep page-world hooks fail-closed. */
  capturePolicy?: CapturePolicy;
  /** Disables fetch/xhr/EventSource monkeypatching when browser-side capture is available. */
  captureNetwork?: boolean;
  /** Secret delivered only through scripting results and extension-owned isolated messaging. */
  controlSecret?: string;
  /** Generates the control secret inside the installed MAIN-world closure. */
  secureControl?: boolean;
  /** Testable fail-closed nonce budget; production defaults to the fixed maximum. */
  controlNonceLimit?: number;
};

type InjectedDirectReplaySnapshot = {
  events: InjectedDirectCaptureEvent[];
  producedThrough: number;
  truncatedBefore: number;
};

type InjectedDirectHookRuntime = {
  activate(config: InjectedCaptureConfig): void;
  deactivate(activationId: string): void;
  drain(activationId: string): InjectedDirectReplaySnapshot;
  snapshot(): InjectedDirectReplaySnapshot;
};

type InjectedHooksInternalOptions = InjectedHooksOptions & {
  directControl?: {
    attach(runtime: InjectedDirectHookRuntime): void;
    replayByteLimit: number;
    replayEventLimit: number;
  };
};

export type InjectedLiteCaptureDirectControllerOptions = {
  captureNetwork?: boolean;
  replayByteLimit?: number;
  replayEventLimit?: number;
};

export type InjectedLiteCaptureDirectController = Readonly<{
  bootstrap(secret: unknown): InjectedDirectBootstrapResult;
  control(secret: unknown, command: unknown): InjectedDirectControlResult;
}>;

/**
 * Creates one document/module-instance direct controller. The capability never
 * enters the hook runtime, page crypto, DOM control events, or window messages.
 */
export function createInjectedLiteCaptureDirectController(
  options: InjectedLiteCaptureDirectControllerOptions = {}
): InjectedLiteCaptureDirectController {
  const replayByteLimit = resolveInjectedDirectReplayByteLimit(options.replayByteLimit);
  const replayEventLimit = resolveInjectedDirectReplayEventLimit(options.replayEventLimit);
  let capability: string | null = null;
  let runtime: InjectedDirectHookRuntime | null = null;
  let phase: InjectedDirectControllerPhase = "inactive";
  let revision = 0;
  let controlledActivationId: string | null = null;

  return {
    bootstrap(candidate): InjectedDirectBootstrapResult {
      if (capability !== null) {
        if (!matchesInjectedDirectCapability(capability, candidate)) {
          return { kind: "rejected" };
        }
        return runtime ? { kind: "existing", phase, revision } : { kind: "unavailable" };
      }

      if (!isInjectedDirectCapability(candidate) || typeof window === "undefined") {
        return typeof window === "undefined" && isInjectedDirectCapability(candidate)
          ? { kind: "unavailable" }
          : { kind: "rejected" };
      }

      capability = candidate;
      try {
        installInjectedLiteCaptureHooksInternal({
          active: false,
          bodyCaptureMaxBytes: 0,
          captureNetwork: options.captureNetwork === true,
          directControl: {
            attach(attachedRuntime): void {
              runtime = attachedRuntime;
            },
            replayByteLimit,
            replayEventLimit
          }
        });
      } catch {
        capability = null;
        runtime = null;
        return { kind: "unavailable" };
      }

      if (!runtime) {
        capability = null;
        return { kind: "unavailable" };
      }

      return { kind: "installed", phase, revision };
    },

    control(candidate, rawCommand): InjectedDirectControlResult {
      if (capability === null || !matchesInjectedDirectCapability(capability, candidate)) {
        return { kind: "rejected", reason: "capability" };
      }

      if (!runtime) {
        return { kind: "unavailable" };
      }

      const command = parseInjectedDirectCommand(rawCommand);
      if (!command) {
        return { kind: "rejected", reason: "invalid-command" };
      }

      if (command.kind === "probe") {
        const replay = runtime.snapshot();
        return {
          kind: "probed",
          phase,
          revision,
          activationId: controlledActivationId,
          producedThrough: replay.producedThrough,
          truncatedBefore: replay.truncatedBefore
        };
      }

      if (command.revision <= revision) {
        return { kind: "rejected", reason: "stale" };
      }

      if (command.kind === "activate") {
        runtime.activate(command.config);
        phase = "active";
        revision = command.revision;
        controlledActivationId = command.config.activationId;
        return {
          kind: "activated",
          activationId: command.config.activationId,
          revision
        };
      }

      if (controlledActivationId !== command.activationId) {
        return { kind: "rejected", reason: "activation-mismatch" };
      }

      if (command.kind === "deactivate") {
        runtime.deactivate(command.activationId);
        phase = "inactive";
        revision = command.revision;
        controlledActivationId = null;
        return { kind: "deactivated", activationId: command.activationId, revision };
      }

      if (phase !== "active" && phase !== "drained") {
        return { kind: "rejected", reason: "activation-mismatch" };
      }

      const replayed = phase === "drained";
      const replay = replayed ? runtime.snapshot() : runtime.drain(command.activationId);
      phase = "drained";
      revision = command.revision;
      return {
        kind: "drained",
        activationId: command.activationId,
        revision,
        events: replay.events,
        producedThrough: replay.producedThrough,
        truncatedBefore: replay.truncatedBefore,
        degraded: replay.truncatedBefore > 0,
        replayed
      };
    }
  };
}

const injectedLiteCaptureDirectController = createInjectedLiteCaptureDirectController();

/** Extension ESM entrypoint target; alias this export to `bootstrap`. */
export function bootstrapInjectedLiteCaptureDirect(secret: unknown): InjectedDirectBootstrapResult {
  return injectedLiteCaptureDirectController.bootstrap(secret);
}

/** Extension ESM entrypoint target; alias this export to `control`. */
export function controlInjectedLiteCaptureDirect(
  secret: unknown,
  command: unknown
): InjectedDirectControlResult {
  return injectedLiteCaptureDirectController.control(secret, command);
}

function resolveInjectedDirectReplayEventLimit(value: unknown): number {
  return typeof value === "number" && value > 0 && value <= 4_096 && value % 1 === 0
    ? value
    : INJECTED_DIRECT_REPLAY_EVENT_LIMIT;
}

function resolveInjectedDirectReplayByteLimit(value: unknown): number {
  return typeof value === "number" &&
    value > 0 &&
    value <= INJECTED_DIRECT_REPLAY_BYTE_LIMIT_MAX &&
    value % 1 === 0
    ? value
    : INJECTED_DIRECT_REPLAY_BYTE_LIMIT;
}

function isInjectedDirectCapability(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 64) {
    return false;
  }
  for (let index = 0; index < 64; index += 1) {
    const character = value[index] ?? "";
    if (!((character >= "0" && character <= "9") || (character >= "a" && character <= "f"))) {
      return false;
    }
  }
  return true;
}

/** Always scans all 64 positions before accepting or rejecting a candidate. */
function matchesInjectedDirectCapability(expected: string, candidate: unknown): boolean {
  const candidateString = typeof candidate === "string" ? candidate : "";
  let mismatch = typeof candidate === "string" && candidateString.length === 64 ? 0 : 1;
  for (let index = 0; index < 64; index += 1) {
    mismatch |= expected[index] === candidateString[index] ? 0 : 1;
  }
  return mismatch === 0;
}

function parseInjectedDirectCommand(value: unknown): InjectedDirectCommand | null {
  const command = asPlainRecord(value);
  if (!command || typeof command.kind !== "string") {
    return null;
  }
  if (command.kind === "probe") {
    return hasAllExactKeys(command, ["kind"]) ? { kind: "probe" } : null;
  }
  if (!isInjectedDirectRevision(command.revision)) {
    return null;
  }
  if (command.kind === "activate") {
    if (!hasAllExactKeys(command, ["kind", "revision", "config"])) {
      return null;
    }
    const config = parseInjectedCaptureConfig(command.config);
    return config?.active === true
      ? { kind: "activate", revision: command.revision, config }
      : null;
  }
  if (command.kind !== "deactivate" && command.kind !== "drain") {
    return null;
  }
  return hasAllExactKeys(command, ["kind", "revision", "activationId"]) &&
    isInjectedActivationId(command.activationId)
    ? {
        kind: command.kind,
        revision: command.revision,
        activationId: command.activationId
      }
    : null;
}

function isInjectedDirectRevision(value: unknown): value is number {
  return (
    typeof value === "number" &&
    value > 0 &&
    value <= INJECTED_DIRECT_MAX_REVISION &&
    value % 1 === 0
  );
}

/**
 * Installs lightweight console/error/network/storage hooks into the current page.
 * Hooks emit capture events via `window.postMessage`.
 */
export function installInjectedLiteCaptureHooks(options: InjectedHooksOptions = {}): string | null {
  return installInjectedLiteCaptureHooksInternal(options);
}

function installInjectedLiteCaptureHooksInternal(
  options: InjectedHooksInternalOptions
): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const flag = options.flag ?? DEFAULT_FLAG;
  const windowFlags = window as unknown as Record<string, unknown>;
  const directControl = options.directControl;

  // Bootstrap options are installation-only. Runtime changes must use the config event.
  if (!directControl && windowFlags[flag]) {
    return null;
  }

  if (options.secureControl === true && options.controlSecret !== undefined) {
    return null;
  }

  const controlSecret =
    options.secureControl === true ? createInjectedControlSecret() : options.controlSecret;
  if (controlSecret !== undefined && !isInjectedControlSecret(controlSecret)) {
    return null;
  }

  if (!directControl) {
    windowFlags[flag] = true;
  }

  let networkRequestSeq = 0;
  let bodyWindowStartedAt = Date.now();
  let bodyWindowCount = 0;
  let bodyWindowBytes = 0;
  let noisyConsoleWindowStartedAt = Date.now();
  let noisyConsoleWindowCount = 0;
  let emitFlushTimer = 0;
  let captureActive = options.active !== false;
  let activationId = captureActive
    ? isInjectedActivationId(options.activationId)
      ? options.activationId
      : createInjectedActivationId()
    : null;
  captureActive = captureActive && activationId !== null;
  let capturePolicy = options.capturePolicy ?? DEFAULT_CAPTURE_POLICY;
  const pendingCaptureEvents: InjectedCaptureEvent[] = [];
  const directReplayEvents: InjectedDirectCaptureEvent[] = [];
  const directReplayEventBytes: number[] = [];
  let directReplayBytes = 0;
  let directProducedThrough = 0;
  let directTruncatedBefore = 0;
  let configuredNetworkBodyCaptureMaxBytes = normalizeConfiguredBodyCaptureMaxBytes(
    options.bodyCaptureMaxBytes
  );
  let networkBodyCaptureMaxBytes = resolveNetworkBodyCaptureMaxBytes();
  const captureNetwork = options.captureNetwork !== false;
  const seenControlNonces = new Set<string>();
  const controlNonceLimit =
    Number.isSafeInteger(options.controlNonceLimit) &&
    (options.controlNonceLimit as number) > 0 &&
    (options.controlNonceLimit as number) <= INJECTED_CONTROL_SEEN_NONCES_MAX
      ? (options.controlNonceLimit as number)
      : INJECTED_CONTROL_SEEN_NONCES_MAX;
  let controlLocked = false;
  let controlTail = Promise.resolve();

  if (!directControl) {
    window.addEventListener(INJECTED_CAPTURE_CONFIG_EVENT, (event: Event) => {
      const rawDetail = cloneInjectedControlDetail((event as CustomEvent<unknown>).detail);
      if (!rawDetail) {
        return;
      }

      if (!controlSecret) {
        const detail = parseInjectedCaptureConfig(rawDetail);
        if (detail) {
          applyCaptureConfig(detail);
          postInjectedArmed(detail.activationId);
        }
        return;
      }

      controlTail = controlTail
        .then(async () => {
          const detail = parseAuthenticatedInjectedCaptureConfig(rawDetail);
          if (
            controlLocked ||
            !detail ||
            seenControlNonces.has(detail.nonce) ||
            !(await verifyInjectedControlPayload(
              controlSecret,
              serializeInjectedConfigControl("request", detail, detail.nonce),
              detail.proof
            ))
          ) {
            return;
          }

          if (!rememberControlNonce(detail.nonce)) return;
          applyCaptureConfig(detail);
          await postAuthenticatedInjectedControlAck(
            "injected-armed-authenticated",
            detail.activationId,
            detail.nonce
          );
        })
        .catch(lockControlChannel);
    });

    window.addEventListener(INJECTED_CAPTURE_DRAIN_EVENT, (event: Event) => {
      const rawDetail = cloneInjectedControlDetail((event as CustomEvent<unknown>).detail);
      if (!rawDetail) {
        return;
      }

      if (!controlSecret) {
        const detail = asPlainRecord(rawDetail);
        const requestedActivationId = detail?.activationId;
        if (
          detail &&
          hasAllExactKeys(detail, ["activationId"]) &&
          isInjectedActivationId(requestedActivationId) &&
          activationId === requestedActivationId
        ) {
          flushPendingCaptureEvents(requestedActivationId);
          resetActivationState();
          postInjectedDrained(requestedActivationId);
        }
        return;
      }

      controlTail = controlTail
        .then(async () => {
          const detail = parseAuthenticatedInjectedCaptureDrainRequest(rawDetail);
          if (
            controlLocked ||
            !detail ||
            seenControlNonces.has(detail.nonce) ||
            activationId !== detail.activationId ||
            !(await verifyInjectedControlPayload(
              controlSecret,
              serializeInjectedDrainControl("request", detail.activationId, detail.nonce),
              detail.proof
            ))
          ) {
            return;
          }

          if (!rememberControlNonce(detail.nonce)) return;
          flushPendingCaptureEvents(detail.activationId);
          resetActivationState();
          await postAuthenticatedInjectedControlAck(
            "injected-drained-authenticated",
            detail.activationId,
            detail.nonce
          );
        })
        .catch(lockControlChannel);
    });
  }

  directControl?.attach({
    activate(config): void {
      if (activationId !== config.activationId) {
        resetDirectReplayState();
      }
      applyCaptureConfig(config);
    },
    deactivate(requestedActivationId): void {
      if (activationId === requestedActivationId) {
        flushPendingCaptureEvents(requestedActivationId);
        resetActivationState();
      }
    },
    drain(requestedActivationId): InjectedDirectReplaySnapshot {
      if (activationId === requestedActivationId) {
        flushPendingCaptureEvents(requestedActivationId);
        resetActivationState();
      }
      return snapshotDirectReplay();
    },
    snapshot(): InjectedDirectReplaySnapshot {
      return snapshotDirectReplay();
    }
  });

  installConsoleHooks();
  installErrorHooks();
  installStorageHooks();
  if (captureNetwork) {
    installNetworkHooks();
  }
  installIndexedDbHooks();

  emit("notice", {
    message: "injected-ready",
    href: readCurrentPageUrl()
  });

  if (!controlSecret && captureActive && activationId) {
    postInjectedArmed(activationId);
  }

  function applyCaptureConfig(detail: InjectedCaptureConfig): void {
    if (!detail.active) {
      if (activationId === detail.activationId) {
        flushPendingCaptureEvents(detail.activationId);
        resetActivationState();
      }
      return;
    }

    if (activationId !== detail.activationId) {
      resetActivationState();
    }

    if (detail.capturePolicy) {
      capturePolicy = detail.capturePolicy;
    }

    if (Object.prototype.hasOwnProperty.call(detail, "bodyCaptureMaxBytes")) {
      configuredNetworkBodyCaptureMaxBytes = normalizeConfiguredBodyCaptureMaxBytes(
        detail.bodyCaptureMaxBytes
      );
    }

    activationId = detail.activationId;
    captureActive = true;
    networkBodyCaptureMaxBytes = resolveNetworkBodyCaptureMaxBytes();
  }

  function rememberControlNonce(nonce: string): boolean {
    if (seenControlNonces.size >= controlNonceLimit) {
      controlLocked = true;
      resetActivationState();
      return false;
    }
    seenControlNonces.add(nonce);
    return true;
  }

  function lockControlChannel(): void {
    controlLocked = true;
    resetActivationState();
  }

  async function postAuthenticatedInjectedControlAck(
    kind: AuthenticatedInjectedCaptureControlAck["kind"],
    acknowledgedActivationId: string,
    nonce: string
  ): Promise<void> {
    if (!controlSecret) return;
    const direction = kind === "injected-armed-authenticated" ? "armed" : "drained";
    const message: AuthenticatedInjectedCaptureControlAck = {
      source: INJECTED_MESSAGE_SOURCE,
      kind,
      activationId: acknowledgedActivationId,
      nonce,
      proof: await signInjectedControlPayload(
        controlSecret,
        serializeInjectedDrainControl(direction, acknowledgedActivationId, nonce)
      )
    };
    window.postMessage(message, "*");
  }

  function emit(
    rawType: string,
    payload: CapturePayload,
    expectedActivationId: string | null = activationId
  ): void {
    const eventActivationId = expectedActivationId;

    if (!captureActive || !eventActivationId || activationId !== eventActivationId) {
      return;
    }

    const seq = directControl ? (directProducedThrough += 1) : undefined;
    const captureEvent: InjectedCaptureEvent = {
      activationId: eventActivationId,
      ...(seq === undefined ? {} : { seq }),
      rawType,
      payload,
      t: Date.now(),
      mono: monotonicTime()
    };
    pendingCaptureEvents.push(captureEvent);
    if (directControl && seq !== undefined) {
      directReplayEvents.push(captureEvent as InjectedDirectCaptureEvent);
      const eventBytes = estimateInjectedDirectEventBytes(captureEvent);
      directReplayEventBytes.push(eventBytes);
      directReplayBytes += eventBytes;
      while (
        directReplayEvents.length > directControl.replayEventLimit ||
        directReplayBytes > directControl.replayByteLimit
      ) {
        const removed = directReplayEvents.shift();
        directReplayBytes -= directReplayEventBytes.shift() ?? 0;
        if (removed) {
          directTruncatedBefore = removed.seq;
        }
      }
    }

    if (pendingCaptureEvents.length >= EMIT_FLUSH_MAX_EVENTS) {
      flushPendingCaptureEvents(eventActivationId);
      return;
    }

    schedulePendingCaptureFlush(eventActivationId);
  }

  function emitPrivacyViolation(blockedRawType: string, reason: string): void {
    emit("privacyViolation", {
      blockedRawType,
      reason,
      policyMode: capturePolicy.mode,
      redacted: true
    });
  }

  function schedulePendingCaptureFlush(expectedActivationId: string): void {
    if (emitFlushTimer > 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (emitFlushTimer !== timer) {
        return;
      }

      emitFlushTimer = 0;
      flushPendingCaptureEvents(expectedActivationId);
    }, 0);
    emitFlushTimer = timer;
  }

  function flushPendingCaptureEvents(expectedActivationId: string): void {
    if (emitFlushTimer > 0) {
      clearTimeout(emitFlushTimer);
      emitFlushTimer = 0;
    }

    if (
      !captureActive ||
      activationId !== expectedActivationId ||
      pendingCaptureEvents.length === 0
    ) {
      return;
    }

    if (pendingCaptureEvents.some((event) => event.activationId !== expectedActivationId)) {
      pendingCaptureEvents.length = 0;
      return;
    }

    const events = pendingCaptureEvents.splice(0, pendingCaptureEvents.length);
    const first = events[0];
    const message: InjectedCaptureWindowMessage =
      events.length === 1 && first
        ? {
            source: INJECTED_MESSAGE_SOURCE,
            kind: "capture-event",
            activationId: expectedActivationId,
            ...(first.seq === undefined ? {} : { seq: first.seq }),
            rawType: first.rawType,
            payload: first.payload,
            t: first.t,
            mono: first.mono
          }
        : {
            source: INJECTED_MESSAGE_SOURCE,
            kind: "capture-events",
            activationId: expectedActivationId,
            events
          };

    window.postMessage(message, "*");
  }

  function resetDirectReplayState(): void {
    directReplayEvents.length = 0;
    directReplayEventBytes.length = 0;
    directReplayBytes = 0;
    directProducedThrough = 0;
    directTruncatedBefore = 0;
  }

  function snapshotDirectReplay(): InjectedDirectReplaySnapshot {
    return {
      events: directReplayEvents.map((event) => ({ ...event })),
      producedThrough: directProducedThrough,
      truncatedBefore: directTruncatedBefore
    };
  }

  function estimateInjectedDirectEventBytes(event: InjectedCaptureEvent): number {
    return estimateInjectedDirectValueBytes(event, 0);
  }

  function estimateInjectedDirectValueBytes(value: unknown, depth: number): number {
    if (depth > INJECTED_MESSAGE_MAX_DEPTH + 2) {
      return 16;
    }
    if (value === null || value === undefined || typeof value === "boolean") {
      return 8;
    }
    if (typeof value === "number") {
      return 16;
    }
    if (typeof value === "string") {
      return 2 * value.length + 8;
    }
    if (Array.isArray(value)) {
      let bytes = 16;
      for (const entry of value) {
        bytes += estimateInjectedDirectValueBytes(entry, depth + 1);
      }
      return bytes;
    }
    const record = asPlainRecord(value);
    if (!record) {
      return 32;
    }
    let bytes = 16;
    for (const key of Object.keys(record)) {
      bytes += 2 * key.length + 8;
      try {
        bytes += estimateInjectedDirectValueBytes(record[key], depth + 1);
      } catch {
        bytes += 32;
      }
    }
    return bytes;
  }

  function resetActivationState(): void {
    captureActive = false;
    activationId = null;
    capturePolicy = DEFAULT_CAPTURE_POLICY;
    configuredNetworkBodyCaptureMaxBytes = 0;
    networkBodyCaptureMaxBytes = 0;

    if (emitFlushTimer > 0) {
      clearTimeout(emitFlushTimer);
      emitFlushTimer = 0;
    }

    pendingCaptureEvents.length = 0;
    bodyWindowStartedAt = Date.now();
    bodyWindowCount = 0;
    bodyWindowBytes = 0;
    noisyConsoleWindowStartedAt = Date.now();
    noisyConsoleWindowCount = 0;
  }

  function postInjectedArmed(armedActivationId: string): void {
    const message: InjectedCaptureArmedMessage = {
      source: INJECTED_MESSAGE_SOURCE,
      kind: "injected-armed",
      activationId: armedActivationId
    };
    window.postMessage(message, "*");
  }

  function postInjectedDrained(drainedActivationId: string): void {
    const message: InjectedCaptureDrainedMessage = {
      source: INJECTED_MESSAGE_SOURCE,
      kind: "injected-drained",
      activationId: drainedActivationId
    };
    window.postMessage(message, "*");
  }

  function monotonicTime(): number {
    return performance.timeOrigin + performance.now();
  }

  function allowBodyCapture(sampledBytes: number): boolean {
    if (networkBodyCaptureMaxBytes <= 0 || sampledBytes > networkBodyCaptureMaxBytes) {
      return false;
    }

    const now = Date.now();

    if (now - bodyWindowStartedAt >= 60_000) {
      bodyWindowStartedAt = now;
      bodyWindowCount = 0;
      bodyWindowBytes = 0;
    }

    if (bodyWindowCount >= NETWORK_BODY_CAPTURE_MAX_PER_MINUTE) {
      return false;
    }

    if (bodyWindowBytes + sampledBytes > NETWORK_BODY_CAPTURE_MAX_BYTES_PER_MINUTE) {
      return false;
    }

    bodyWindowCount += 1;
    bodyWindowBytes += sampledBytes;
    return true;
  }

  function installConsoleHooks(): void {
    const consoleMethods = [
      "log",
      "info",
      "warn",
      "error",
      "debug",
      "assert",
      "trace",
      "dir",
      "dirxml",
      "table",
      "group",
      "groupCollapsed",
      "groupEnd",
      "count",
      "countReset",
      "time",
      "timeEnd",
      "timeLog",
      "clear"
    ] as const;
    const consoleRecord = console as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const method of consoleMethods) {
      const original = consoleRecord[method];

      if (typeof original !== "function") {
        continue;
      }

      consoleRecord[method] = (...args: unknown[]) => {
        if (method === "assert" && Boolean(args[0])) {
          return Reflect.apply(original, console, args);
        }

        if (!captureActive) {
          return Reflect.apply(original, console, args);
        }

        const now = Date.now();

        if (now - noisyConsoleWindowStartedAt >= 1_000) {
          noisyConsoleWindowStartedAt = now;
          noisyConsoleWindowCount = 0;
        }

        if (NOISY_CONSOLE_METHODS.has(method)) {
          noisyConsoleWindowCount += 1;

          if (noisyConsoleWindowCount > NOISY_CONSOLE_MAX_PER_SEC) {
            return Reflect.apply(original, console, args);
          }
        }

        const level = consoleMethodToLevel(method);
        const basePayload = {
          source: "injected",
          method,
          level,
          redacted: capturePolicy.categories.console !== "allow"
        };

        if (capturePolicy.categories.console === "off") {
          emitPrivacyViolation("console", "console-disabled");
          return Reflect.apply(original, console, args);
        }

        if (capturePolicy.categories.console === "metadata") {
          emit("console", basePayload);
          return Reflect.apply(original, console, args);
        }

        const serializedArgs = args.slice(0, 10).map((value) => safeSerialize(value));
        const includeStack =
          method === "error" || method === "warn" || method === "assert" || method === "trace";

        emit("console", {
          ...basePayload,
          args: serializedArgs,
          text: formatConsoleText(serializedArgs),
          stackTop: includeStack ? readStackTop() : undefined
        });

        return Reflect.apply(original, console, args);
      };
    }
  }

  function consoleMethodToLevel(method: string): "log" | "info" | "warn" | "error" | "debug" {
    if (method === "error" || method === "assert") {
      return "error";
    }

    if (method === "warn") {
      return "warn";
    }

    if (method === "info") {
      return "info";
    }

    if (method === "debug" || method === "trace") {
      return "debug";
    }

    return "log";
  }

  function formatConsoleText(args: unknown[]): string {
    if (args.length === 0) {
      return "";
    }

    const parts = args
      .slice(0, 8)
      .map((entry) => stringifyValue(entry))
      .filter((entry) => entry.length > 0);
    const joined = parts.join(" ");
    return joined.length > 600 ? `${joined.slice(0, 597)}...` : joined;
  }

  function stringifyValue(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }

    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      return String(value);
    }

    if (value === undefined) {
      return "undefined";
    }

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function readStackTop(): string | undefined {
    const stack = new Error().stack;

    if (!stack) {
      return undefined;
    }

    const lines = stack.split("\n").map((line) => line.trim());
    const selfLine = lines.findIndex((line) => line.includes("installConsoleHooks"));
    const candidate =
      selfLine >= 0 ? (lines[selfLine + 2] ?? lines[selfLine + 1]) : (lines[2] ?? lines[1]);

    return candidate ? candidate.slice(0, 260) : undefined;
  }

  function installErrorHooks(): void {
    window.addEventListener("error", (event) => {
      if (!captureActive) {
        return;
      }

      const target = event.target;

      if (target instanceof HTMLElement && ["SCRIPT", "LINK", "IMG"].includes(target.tagName)) {
        emit("resourceError", {
          tag: target.tagName,
          url: readTargetUrl(target)
        });
        return;
      }

      if (capturePolicy.categories.console === "off") {
        emitPrivacyViolation("pageError", "console-disabled");
        return;
      }

      if (capturePolicy.categories.console === "metadata") {
        emit("pageError", {
          filename: sanitizeOptionalUrl(event.filename),
          lineno: event.lineno,
          colno: event.colno,
          messageRedacted: true,
          stackRedacted: true
        });
        return;
      }

      emit("pageError", {
        message: event.message,
        filename: sanitizeOptionalUrl(event.filename),
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error instanceof Error ? event.error.stack : undefined
      });
    });

    window.addEventListener("unhandledrejection", (event) => {
      if (!captureActive) {
        return;
      }

      if (capturePolicy.categories.console === "off") {
        emitPrivacyViolation("unhandledrejection", "console-disabled");
        return;
      }

      if (capturePolicy.categories.console === "metadata") {
        emit("unhandledrejection", {
          reasonRedacted: true
        });
        return;
      }

      emit("unhandledrejection", {
        reason: safeSerialize(event.reason)
      });
    });
  }

  function installStorageHooks(): void {
    try {
      const localSetItem = localStorage.setItem.bind(localStorage);
      const localRemoveItem = localStorage.removeItem.bind(localStorage);
      const localClear = localStorage.clear.bind(localStorage);

      localStorage.setItem = (key: string, value: string) => {
        if (captureActive) {
          emitStorageOperation("localStorageOp", "setItem", key, value.length);
        }

        localSetItem(key, value);
      };

      localStorage.removeItem = (key: string) => {
        if (captureActive) {
          emitStorageOperation("localStorageOp", "removeItem", key);
        }

        localRemoveItem(key);
      };

      localStorage.clear = () => {
        if (captureActive) {
          emitStorageOperation("localStorageOp", "clear");
        }

        localClear();
      };
    } catch {
      emit("notice", { message: "localStorage-hook-failed" });
    }

    try {
      const sessionSetItem = sessionStorage.setItem.bind(sessionStorage);
      const sessionRemoveItem = sessionStorage.removeItem.bind(sessionStorage);
      const sessionClear = sessionStorage.clear.bind(sessionStorage);

      sessionStorage.setItem = (key: string, value: string) => {
        if (captureActive) {
          emitStorageOperation("sessionStorageOp", "setItem", key, value.length);
        }

        sessionSetItem(key, value);
      };

      sessionStorage.removeItem = (key: string) => {
        if (captureActive) {
          emitStorageOperation("sessionStorageOp", "removeItem", key);
        }

        sessionRemoveItem(key);
      };

      sessionStorage.clear = () => {
        if (captureActive) {
          emitStorageOperation("sessionStorageOp", "clear");
        }

        sessionClear();
      };
    } catch {
      emit("notice", { message: "sessionStorage-hook-failed" });
    }
  }

  function emitStorageOperation(
    rawType: "localStorageOp" | "sessionStorageOp",
    op: string,
    key?: string,
    valueLength?: number
  ): void {
    const mode = capturePolicy.categories.storage;

    if (mode === "off") {
      emitPrivacyViolation(rawType, "storage-disabled");
      return;
    }

    const payload: CapturePayload = {
      op,
      redacted: mode !== "allow"
    };

    if (key && (mode === "allow" || mode === "names-only")) {
      payload.key = key;
    } else if (key) {
      payload.keyRedacted = true;
    }

    if (typeof valueLength === "number" && (mode === "allow" || mode === "lengths-only")) {
      payload.valueLength = valueLength;
    } else if (typeof valueLength === "number") {
      payload.valueLengthRedacted = true;
    }

    emit(rawType, payload);
  }

  function installNetworkHooks(): void {
    const originalFetch = window.fetch.bind(window);

    window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const requestActivationId = activationId;

      if (!captureActive || !requestActivationId) {
        return originalFetch(...args);
      }

      const requestMeta = resolveFetchRequestMeta(args);
      const reqId = nextRequestId("fetch");
      const startedMono = monotonicTime();

      emit(
        "fetch",
        {
          phase: "start",
          reqId,
          requestId: reqId,
          method: requestMeta.method,
          url: sanitizeOptionalUrl(requestMeta.url),
          headers: shouldCaptureNetworkHeaders() ? requestMeta.headers : undefined,
          postDataSize: requestMeta.postDataSize
        },
        requestActivationId
      );

      try {
        const response = await originalFetch(...args);
        const contentType = normalizeContentType(response.headers.get("content-type"));
        const encodedDataLength = parseHeaderInt(response.headers.get("content-length"));

        emit(
          "fetch",
          {
            phase: "end",
            reqId,
            requestId: reqId,
            method: requestMeta.method,
            url: sanitizeOptionalUrl(requestMeta.url),
            status: response.status,
            statusText: response.statusText,
            ok: response.ok,
            redirected: response.redirected,
            responseUrl: sanitizeOptionalUrl(response.url),
            mimeType: contentType,
            headers: shouldCaptureNetworkHeaders() ? readHeaders(response.headers) : undefined,
            encodedDataLength,
            duration: monotonicTime() - startedMono
          },
          requestActivationId
        );

        void emitFetchResponseBody(reqId, requestMeta, response, requestActivationId);

        return response;
      } catch (error) {
        emit(
          "fetchError",
          {
            reqId,
            requestId: reqId,
            method: requestMeta.method,
            url: sanitizeOptionalUrl(requestMeta.url),
            duration: monotonicTime() - startedMono,
            message: error instanceof Error ? error.message : String(error),
            errorText: error instanceof Error ? error.message : String(error)
          },
          requestActivationId
        );

        throw error;
      }
    };

    const xhrOpen = XMLHttpRequest.prototype.open;
    const xhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      ...rest: [async?: boolean, username?: string | null, password?: string | null]
    ): void {
      const args = [method, url, ...rest];
      const [async, username, password] = rest;

      if (!captureActive) {
        Reflect.apply(xhrOpen, this, args);
        return;
      }

      (
        this as XMLHttpRequest & {
          __wbReqId?: string;
          __wbMethod?: string;
          __wbUrl?: string;
          __wbStartedMono?: number;
          __wbFailed?: boolean;
          __wbActivationId?: string;
        }
      ).__wbReqId = nextRequestId("xhr");
      (
        this as XMLHttpRequest & {
          __wbReqId?: string;
          __wbMethod?: string;
          __wbUrl?: string;
          __wbStartedMono?: number;
          __wbFailed?: boolean;
        }
      ).__wbMethod = method;
      (
        this as XMLHttpRequest & {
          __wbReqId?: string;
          __wbMethod?: string;
          __wbUrl?: string;
          __wbStartedMono?: number;
          __wbFailed?: boolean;
        }
      ).__wbUrl = typeof url === "string" ? url : url.toString();
      (
        this as XMLHttpRequest & {
          __wbReqId?: string;
          __wbMethod?: string;
          __wbUrl?: string;
          __wbStartedMono?: number;
          __wbFailed?: boolean;
        }
      ).__wbFailed = false;
      (
        this as XMLHttpRequest & {
          __wbActivationId?: string;
        }
      ).__wbActivationId = activationId ?? undefined;

      const openArgs: unknown[] = [method, url];

      if (args.length >= 3) {
        openArgs.push(async);
      }

      if (args.length >= 4) {
        openArgs.push(username);
      }

      if (args.length >= 5) {
        openArgs.push(password);
      }

      Reflect.apply(xhrOpen, this, openArgs);
    };

    XMLHttpRequest.prototype.send = function (
      body?: Document | XMLHttpRequestBodyInit | null
    ): void {
      if (!captureActive) {
        return xhrSend.call(this, body as unknown as XMLHttpRequestBodyInit | null | undefined);
      }

      const xhr = this as XMLHttpRequest & {
        __wbReqId?: string;
        __wbMethod?: string;
        __wbUrl?: string;
        __wbStartedMono?: number;
        __wbFailed?: boolean;
        __wbActivationId?: string;
      };
      xhr.__wbStartedMono = monotonicTime();
      const reqId = xhr.__wbReqId ?? nextRequestId("xhr");
      const requestActivationId = xhr.__wbActivationId ?? activationId;
      xhr.__wbReqId = reqId;

      if (!requestActivationId || requestActivationId !== activationId) {
        return xhrSend.call(this, body as unknown as XMLHttpRequestBodyInit | null | undefined);
      }

      emit(
        "xhr",
        {
          phase: "start",
          reqId,
          requestId: reqId,
          method: xhr.__wbMethod ?? "GET",
          url: sanitizeOptionalUrl(xhr.__wbUrl) ?? "unknown",
          postDataSize: estimateBodyLength(body)
        },
        requestActivationId
      );

      const emitXhrFailure = (reason: string) => {
        if (xhr.__wbFailed) {
          return;
        }

        xhr.__wbFailed = true;

        emit(
          "fetchError",
          {
            reqId,
            requestId: reqId,
            method: xhr.__wbMethod ?? "GET",
            url: sanitizeOptionalUrl(xhr.__wbUrl) ?? "unknown",
            duration: monotonicTime() - (xhr.__wbStartedMono ?? monotonicTime()),
            message: reason,
            errorText: reason
          },
          requestActivationId
        );
      };

      this.addEventListener(
        "error",
        () => {
          emitXhrFailure("XHR error");
        },
        { once: true }
      );
      this.addEventListener(
        "abort",
        () => {
          emitXhrFailure("XHR aborted");
        },
        { once: true }
      );
      this.addEventListener(
        "timeout",
        () => {
          emitXhrFailure("XHR timeout");
        },
        { once: true }
      );

      this.addEventListener(
        "loadend",
        () => {
          const contentType = normalizeContentType(this.getResponseHeader("content-type"));

          emit(
            "xhr",
            {
              phase: "end",
              reqId,
              requestId: reqId,
              method: xhr.__wbMethod ?? "GET",
              url: sanitizeOptionalUrl(this.responseURL || xhr.__wbUrl) ?? "unknown",
              status: this.status,
              statusText: this.statusText,
              ok: this.status >= 200 && this.status < 400,
              headers: shouldCaptureNetworkHeaders()
                ? parseXhrResponseHeaders(this.getAllResponseHeaders())
                : undefined,
              mimeType: contentType,
              encodedDataLength: parseHeaderInt(this.getResponseHeader("content-length")),
              failed: Boolean(xhr.__wbFailed),
              duration: monotonicTime() - (xhr.__wbStartedMono ?? monotonicTime())
            },
            requestActivationId
          );

          void emitXhrResponseBody(reqId, xhr, contentType, requestActivationId);
        },
        { once: true }
      );

      xhrSend.call(this, body as unknown as XMLHttpRequestBodyInit | null | undefined);
    };

    if (
      typeof window.EventSource === "function" &&
      !windowFlags.__WEBBLACKBOX_EVENTSOURCE_PATCHED__
    ) {
      const NativeEventSource = window.EventSource;

      class WebBlackboxEventSource extends NativeEventSource {
        public constructor(...args: ConstructorParameters<typeof NativeEventSource>) {
          super(...args);

          if (!captureActive) {
            return;
          }

          const streamActivationId = activationId;

          if (!streamActivationId) {
            return;
          }

          const url = sanitizeUrlForPrivacy(
            typeof args[0] === "string" ? args[0] : String(args[0])
          );
          const streamId = nextRequestId("sse");

          emit(
            "sse",
            {
              phase: "open",
              url,
              streamId,
              requestId: streamId
            },
            streamActivationId
          );

          this.addEventListener("message", (event) => {
            const data =
              typeof event.data === "string" ? event.data.slice(0, 800) : safeSerialize(event.data);

            emit(
              "sse",
              {
                phase: "message",
                url,
                streamId,
                requestId: streamId,
                eventType: event.type,
                lastEventId: event.lastEventId,
                ...(capturePolicy.categories.network === "body-allowlist"
                  ? { data }
                  : {
                      dataRedacted: true,
                      dataSize: typeof event.data === "string" ? event.data.length : undefined
                    })
              },
              streamActivationId
            );
          });

          this.addEventListener("error", () => {
            emit(
              "sse",
              {
                phase: "error",
                url,
                streamId,
                requestId: streamId,
                readyState: this.readyState
              },
              streamActivationId
            );
          });
        }
      }

      window.EventSource = WebBlackboxEventSource as typeof EventSource;
      windowFlags.__WEBBLACKBOX_EVENTSOURCE_PATCHED__ = true;
    }
  }

  async function emitFetchResponseBody(
    reqId: string,
    requestMeta: {
      method: string;
      url: string;
    },
    response: Response,
    expectedActivationId: string
  ): Promise<void> {
    if (activationId !== expectedActivationId) {
      return;
    }

    if (response.type === "opaque" || response.type === "opaqueredirect") {
      return;
    }

    const contentType = normalizeContentType(response.headers.get("content-type"));

    if (!isBodyCaptureMimeAllowed(contentType)) {
      return;
    }

    const encodedDataLength = parseHeaderInt(response.headers.get("content-length"));

    const maxBodyCaptureBytes = networkBodyCaptureMaxBytes;

    if (maxBodyCaptureBytes <= 0) {
      return;
    }

    if (typeof encodedDataLength === "number" && encodedDataLength > maxBodyCaptureBytes) {
      return;
    }

    const sampled = await readFetchBodySample(response, maxBodyCaptureBytes);

    if (activationId !== expectedActivationId || !sampled || sampled.body.length === 0) {
      return;
    }

    if (!allowBodyCapture(sampled.sampledBytes)) {
      return;
    }

    emit(
      "networkBody",
      {
        source: "fetch",
        reqId,
        requestId: reqId,
        method: requestMeta.method,
        url: sanitizeOptionalUrl(response.url || requestMeta.url) ?? "unknown",
        status: response.status,
        mimeType: contentType,
        encoding: "utf8",
        body: sampled.body,
        size:
          typeof encodedDataLength === "number"
            ? encodedDataLength
            : sampled.truncated
              ? Math.max(sampled.sampledBytes + 1, sampled.sampledBytes)
              : sampled.sampledBytes,
        sampledSize: sampled.sampledBytes,
        truncated:
          sampled.truncated ||
          (typeof encodedDataLength === "number" && encodedDataLength > sampled.sampledBytes)
      },
      expectedActivationId
    );
  }

  async function emitXhrResponseBody(
    reqId: string,
    xhr: XMLHttpRequest & {
      __wbMethod?: string;
      __wbUrl?: string;
    },
    contentType: string | undefined,
    expectedActivationId: string
  ): Promise<void> {
    if (activationId !== expectedActivationId) {
      return;
    }

    if (!isBodyCaptureMimeAllowed(contentType)) {
      return;
    }

    const encodedDataLength = parseHeaderInt(xhr.getResponseHeader("content-length"));

    const maxBodyCaptureBytes = networkBodyCaptureMaxBytes;

    if (maxBodyCaptureBytes <= 0) {
      return;
    }

    if (typeof encodedDataLength === "number" && encodedDataLength > maxBodyCaptureBytes) {
      return;
    }

    const bodyText = await readXhrBodyText(xhr);

    if (activationId !== expectedActivationId || !bodyText || bodyText.length === 0) {
      return;
    }

    const clipped = clipUtf8Text(bodyText, maxBodyCaptureBytes);
    const sampledSize = new TextEncoder().encode(clipped.value).byteLength;

    if (!allowBodyCapture(sampledSize)) {
      return;
    }

    emit(
      "networkBody",
      {
        source: "xhr",
        reqId,
        requestId: reqId,
        method: xhr.__wbMethod ?? "GET",
        url: sanitizeOptionalUrl(xhr.responseURL || xhr.__wbUrl) ?? "unknown",
        status: xhr.status,
        statusText: xhr.statusText,
        mimeType: contentType,
        encoding: "utf8",
        body: clipped.value,
        size: typeof encodedDataLength === "number" ? encodedDataLength : clipped.fullBytes,
        sampledSize,
        truncated:
          clipped.truncated ||
          (typeof encodedDataLength === "number" && encodedDataLength > sampledSize)
      },
      expectedActivationId
    );
  }

  async function readFetchBodySample(
    response: Response,
    maxBytes: number
  ): Promise<{ body: string; sampledBytes: number; truncated: boolean } | null> {
    const cloned = response.clone();

    if (!cloned.body || typeof cloned.body.getReader !== "function") {
      try {
        const bodyText = await cloned.text();
        const clipped = clipUtf8Text(bodyText, maxBytes);
        const sampledBytes = new TextEncoder().encode(clipped.value).byteLength;
        return {
          body: clipped.value,
          sampledBytes,
          truncated: clipped.truncated
        };
      } catch {
        return null;
      }
    }

    const reader = cloned.body.getReader();
    const chunks: Uint8Array[] = [];
    let sampledBytes = 0;
    let truncated = false;

    try {
      while (sampledBytes < maxBytes) {
        const result = await reader.read();

        if (result.done) {
          break;
        }

        const value = toUint8Array(result.value);

        if (!value || value.byteLength === 0) {
          continue;
        }

        const remaining = maxBytes - sampledBytes;

        if (value.byteLength <= remaining) {
          chunks.push(value);
          sampledBytes += value.byteLength;
          continue;
        }

        chunks.push(value.slice(0, remaining));
        sampledBytes += remaining;
        truncated = true;
        break;
      }
    } catch {
      return null;
    } finally {
      try {
        await reader.cancel();
      } catch {
        void 0;
      }
    }

    if (chunks.length === 0) {
      return null;
    }

    const decoder = new TextDecoder();
    let body = "";

    for (const chunk of chunks) {
      body += decoder.decode(chunk, {
        stream: true
      });
    }

    body += decoder.decode();

    return {
      body,
      sampledBytes,
      truncated
    };
  }

  function toUint8Array(value: unknown): Uint8Array | null {
    if (value instanceof Uint8Array) {
      return value;
    }

    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }

    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }

    if (typeof value === "string") {
      return new TextEncoder().encode(value);
    }

    return null;
  }

  async function readXhrBodyText(xhr: XMLHttpRequest): Promise<string | null> {
    const responseType = xhr.responseType;

    if (responseType === "" || responseType === "text") {
      return typeof xhr.responseText === "string" ? xhr.responseText : null;
    }

    if (responseType === "json") {
      if (xhr.response === null || xhr.response === undefined) {
        return null;
      }

      try {
        return JSON.stringify(xhr.response);
      } catch {
        return null;
      }
    }

    if (responseType === "document") {
      const responseDocument = xhr.responseXML;
      return responseDocument?.documentElement?.outerHTML ?? null;
    }

    if (responseType === "arraybuffer" && xhr.response instanceof ArrayBuffer) {
      try {
        return new TextDecoder().decode(new Uint8Array(xhr.response));
      } catch {
        return null;
      }
    }

    if (responseType === "blob" && xhr.response instanceof Blob) {
      try {
        return await xhr.response.text();
      } catch {
        return null;
      }
    }

    return null;
  }

  function clipUtf8Text(
    value: string,
    maxBytes: number
  ): { value: string; fullBytes: number; truncated: boolean } {
    const encoder = new TextEncoder();
    const fullBytes = encoder.encode(value);

    if (fullBytes.byteLength <= maxBytes) {
      return {
        value,
        fullBytes: fullBytes.byteLength,
        truncated: false
      };
    }

    const roughRatio = Math.max(0.05, maxBytes / fullBytes.byteLength);
    let targetChars = Math.max(1, Math.floor(value.length * roughRatio));
    let clipped = value.slice(0, targetChars);
    let clippedBytes = encoder.encode(clipped);

    while (clippedBytes.byteLength > maxBytes && targetChars > 1) {
      targetChars = Math.max(1, Math.floor(targetChars * 0.9));
      clipped = value.slice(0, targetChars);
      clippedBytes = encoder.encode(clipped);
    }

    return {
      value: clipped,
      fullBytes: fullBytes.byteLength,
      truncated: true
    };
  }

  function isBodyCaptureMimeAllowed(mimeType: string | undefined): boolean {
    if (!mimeType) {
      return false;
    }

    const normalized = mimeType.toLowerCase();

    return (
      normalized.startsWith("text/") ||
      normalized.includes("json") ||
      normalized.includes("xml") ||
      normalized.includes("javascript") ||
      normalized.includes("x-www-form-urlencoded")
    );
  }

  function shouldCaptureNetworkHeaders(): boolean {
    return capturePolicy.categories.network !== "metadata";
  }

  function nextRequestId(prefix: "fetch" | "xhr" | "sse"): string {
    networkRequestSeq += 1;
    return `${prefix}-${Date.now().toString(36)}-${networkRequestSeq.toString(36)}`;
  }

  function normalizeConfiguredBodyCaptureMaxBytes(candidate: unknown): number {
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) {
      return 0;
    }

    return Math.max(
      4 * 1024,
      Math.min(8 * 1024 * 1024, Math.round(candidate ?? NETWORK_BODY_CAPTURE_DEFAULT_MAX_BYTES))
    );
  }

  function resolveNetworkBodyCaptureMaxBytes(): number {
    return capturePolicy.categories.network === "body-allowlist"
      ? configuredNetworkBodyCaptureMaxBytes
      : 0;
  }

  function resolveFetchRequestMeta(args: Parameters<typeof fetch>): {
    url: string;
    method: string;
    headers?: Record<string, string>;
    postDataSize?: number;
  } {
    const [request, init] = args;
    const requestInit = init ?? {};
    const requestUrl =
      request instanceof Request
        ? request.url
        : typeof request === "string"
          ? request
          : request instanceof URL
            ? request.toString()
            : "unknown";
    const requestMethod = (
      requestInit.method ??
      (request instanceof Request ? request.method : undefined) ??
      "GET"
    ).toUpperCase();
    const headerSource =
      requestInit.headers ?? (request instanceof Request ? request.headers : undefined);
    const headers = headerSource ? toAllowlistedHeaderRecord(headerSource) : undefined;
    const bodyCandidate = requestInit.body;
    const postDataSize = estimateBodyLength(bodyCandidate);

    return {
      url: requestUrl,
      method: requestMethod,
      headers,
      postDataSize
    };
  }

  function toAllowlistedHeaderRecord(rawHeaders: HeadersInit): Record<string, string> | undefined {
    const headers = new Headers(rawHeaders);
    const output: Record<string, string> = {};
    let count = 0;

    headers.forEach((value, key) => {
      if (count >= 64) {
        return;
      }

      if (!NETWORK_HEADER_ALLOWLIST.has(key.toLowerCase())) {
        return;
      }

      output[key] = value.slice(0, 500);
      count += 1;
    });

    return count > 0 ? output : undefined;
  }

  function readHeaders(headers: Headers): Record<string, string> | undefined {
    return toAllowlistedHeaderRecord(headers);
  }

  function parseXhrResponseHeaders(value: string): Record<string, string> | undefined {
    if (value.trim().length === 0) {
      return undefined;
    }

    const output: Record<string, string> = {};
    let count = 0;

    for (const line of value.split(/\r?\n/)) {
      if (count >= 64 || line.trim().length === 0) {
        continue;
      }

      const separatorIndex = line.indexOf(":");

      if (separatorIndex <= 0) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim().toLowerCase();
      const entry = line.slice(separatorIndex + 1).trim();

      if (!key) {
        continue;
      }

      if (!NETWORK_HEADER_ALLOWLIST.has(key)) {
        continue;
      }

      output[key] = entry.slice(0, 500);
      count += 1;
    }

    return Object.keys(output).length > 0 ? output : undefined;
  }

  function parseHeaderInt(value: string | null): number | undefined {
    if (!value) {
      return undefined;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  function normalizeContentType(value: string | null): string | undefined {
    if (!value) {
      return undefined;
    }

    const [mime] = value.split(";");
    const normalized = mime?.trim().toLowerCase();
    return normalized && normalized.length > 0 ? normalized : undefined;
  }

  function estimateBodyLength(body: unknown): number | undefined {
    if (typeof body === "string") {
      return new TextEncoder().encode(body).byteLength;
    }

    if (body instanceof URLSearchParams) {
      return new TextEncoder().encode(body.toString()).byteLength;
    }

    if (body instanceof Blob) {
      return body.size;
    }

    if (body instanceof ArrayBuffer) {
      return body.byteLength;
    }

    if (ArrayBuffer.isView(body)) {
      return body.byteLength;
    }

    if (body instanceof FormData) {
      let length = 0;

      for (const [, entry] of body.entries()) {
        if (typeof entry === "string") {
          length += new TextEncoder().encode(entry).byteLength;
          continue;
        }

        length += entry.size;
      }

      return length;
    }

    return undefined;
  }

  function installIndexedDbHooks(): void {
    if (!("indexedDB" in window) || typeof indexedDB.open !== "function") {
      return;
    }

    const open = indexedDB.open.bind(indexedDB);

    indexedDB.open = (name: string, version?: number) => {
      const indexedDbMode = capturePolicy.categories.indexedDb;

      if (captureActive && indexedDbMode !== "off") {
        emit(
          "indexedDbOp",
          indexedDbMode === "names-only"
            ? {
                op: "open",
                name,
                version
              }
            : {
                op: "open"
              }
        );
      }

      return open(name, version);
    };
  }

  function readTargetUrl(target: HTMLElement): string | undefined {
    if (target instanceof HTMLScriptElement || target instanceof HTMLImageElement) {
      return sanitizeOptionalUrl(target.src);
    }

    if (target instanceof HTMLLinkElement) {
      return sanitizeOptionalUrl(target.href);
    }

    return undefined;
  }

  function readCurrentPageUrl(): string {
    return typeof location !== "undefined" && typeof location.href === "string"
      ? sanitizeUrlForPrivacy(location.href)
      : "";
  }

  function sanitizeOptionalUrl(value: string | undefined): string | undefined {
    if (!value || value.length === 0) {
      return undefined;
    }

    const sanitized = sanitizeUrlForPrivacy(value);
    return sanitized.length > 0 ? sanitized : undefined;
  }

  function safeSerialize(value: unknown, depth = 0): unknown {
    if (depth >= SAFE_SERIALIZE_MAX_DEPTH) {
      return summarizeValue(value);
    }

    if (
      value === null ||
      value === undefined ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }

    if (typeof value === "string") {
      return compactString(value, SAFE_SERIALIZE_MAX_STRING_CHARS);
    }

    if (typeof value === "bigint") {
      return value.toString();
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack
      };
    }

    if (typeof value === "function") {
      return `[Function ${value.name || "anonymous"}]`;
    }

    if (value instanceof HTMLElement) {
      return {
        tag: value.tagName,
        id: value.id || undefined,
        className: value.className || undefined,
        text: value.textContent?.trim().slice(0, 120)
      };
    }

    if (Array.isArray(value)) {
      return value.slice(0, 20).map((entry) => safeSerialize(entry, depth + 1));
    }

    if (value instanceof Map) {
      return {
        map: [...value.entries()]
          .slice(0, 20)
          .map(([key, entry]) => [safeSerialize(key, depth + 1), safeSerialize(entry, depth + 1)])
      };
    }

    if (value instanceof Set) {
      return {
        set: [...value.values()].slice(0, 20).map((entry) => safeSerialize(entry, depth + 1))
      };
    }

    if (value instanceof URL) {
      return value.toString();
    }

    if (value instanceof Date) {
      return serializeDate(value);
    }

    if (value instanceof ArrayBuffer) {
      return {
        type: "ArrayBuffer",
        byteLength: value.byteLength
      };
    }

    if (ArrayBuffer.isView(value)) {
      return {
        type: value.constructor.name,
        byteLength: value.byteLength
      };
    }

    if (typeof value === "object") {
      const output: Record<string, unknown> = {};
      let count = 0;
      let keys: string[];

      try {
        keys = Object.keys(value as Record<string, unknown>);
      } catch {
        return summarizeValue(value);
      }

      for (const key of keys) {
        if (count >= SAFE_SERIALIZE_MAX_PROPERTIES) {
          output.__truncated = true;
          break;
        }

        try {
          output[key] = safeSerialize((value as Record<string, unknown>)[key], depth + 1);
        } catch {
          output[key] = "[Unreadable]";
        }

        count += 1;
      }

      return output;
    }

    return String(value);
  }

  function summarizeValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return `[Array(${value.length})]`;
    }

    if (value instanceof Map) {
      return `[Map(${value.size})]`;
    }

    if (value instanceof Set) {
      return `[Set(${value.size})]`;
    }

    if (value instanceof Date) {
      return serializeDate(value);
    }

    if (value instanceof URL) {
      return value.toString();
    }

    if (value && typeof value === "object") {
      return `[${value.constructor?.name || "Object"}]`;
    }

    return String(value);
  }

  function compactString(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }

    return `${value.slice(0, maxLength - 3)}...`;
  }

  function serializeDate(value: Date): string {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }

  return controlSecret ?? null;
}
