import {
  parseContentActivationId,
  type ContentActivationId
} from "./content-activation-protocol.js";
import type {
  InjectedDirectBootstrapResult,
  InjectedDirectControlResult
} from "webblackbox/injected-hooks";

const DIRECT_CAPABILITY_PATTERN = /^[0-9a-f]{64}$/u;
const DIRECT_MODULE_NONCE_PATTERN = /^m1_[0-9a-f]{64}$/u;
const DIRECT_RANDOM_BYTES = 32;

export type MainWorldControllerPhase = "inactive" | "active" | "drained";

export type MainWorldControllerHint = Readonly<{
  secret: string;
  moduleNonce: string;
  revision: number;
  phase: MainWorldControllerPhase;
  activationId: ContentActivationId | null;
}>;

export type MainWorldControllerSeedMessage = Readonly<{
  kind: "sw.main-world-controller-seed";
  controller: MainWorldControllerHint;
}>;

export type MainWorldControllerSeedAck = Readonly<{
  kind: "content.main-world-controller-seeded";
  controller: MainWorldControllerHint;
}>;

type RandomSource = Pick<Crypto, "getRandomValues">;

export function createMainWorldControllerHint(
  random: RandomSource | null | undefined = globalThis.crypto
): MainWorldControllerHint {
  return {
    secret: createRandomHex(random, ""),
    moduleNonce: createRandomHex(random, "m1_"),
    revision: 0,
    phase: "inactive",
    activationId: null
  };
}

export function parseMainWorldControllerHint(value: unknown): MainWorldControllerHint | null {
  try {
    const row = asPlainRecord(value);
    if (
      !row ||
      !hasExactKeys(row, ["secret", "moduleNonce", "revision", "phase", "activationId"]) ||
      typeof row.secret !== "string" ||
      !DIRECT_CAPABILITY_PATTERN.test(row.secret) ||
      typeof row.moduleNonce !== "string" ||
      !DIRECT_MODULE_NONCE_PATTERN.test(row.moduleNonce) ||
      !isRevision(row.revision) ||
      (row.phase !== "inactive" && row.phase !== "active" && row.phase !== "drained")
    ) {
      return null;
    }

    const activationId =
      row.activationId === null ? null : parseContentActivationId(row.activationId);
    if (
      (row.activationId !== null && !activationId) ||
      (row.phase === "active" && !activationId) ||
      (row.phase === "drained" && !activationId) ||
      (row.phase === "inactive" && activationId !== null)
    ) {
      return null;
    }

    return {
      secret: row.secret,
      moduleNonce: row.moduleNonce,
      revision: row.revision,
      phase: row.phase,
      activationId
    };
  } catch {
    return null;
  }
}

export function parseMainWorldControllerSeedMessage(
  value: unknown
): MainWorldControllerSeedMessage | null {
  const row = asPlainRecord(value);
  const controller = parseMainWorldControllerHint(row?.controller);
  return row &&
    hasExactKeys(row, ["kind", "controller"]) &&
    row.kind === "sw.main-world-controller-seed" &&
    controller
    ? { kind: "sw.main-world-controller-seed", controller }
    : null;
}

export function parseMainWorldControllerSeedAck(value: unknown): MainWorldControllerSeedAck | null {
  const row = asPlainRecord(value);
  const controller = parseMainWorldControllerHint(row?.controller);
  return row &&
    hasExactKeys(row, ["kind", "controller"]) &&
    row.kind === "content.main-world-controller-seeded" &&
    controller
    ? { kind: "content.main-world-controller-seeded", controller }
    : null;
}

export function parseInjectedDirectBootstrapResult(
  value: unknown
): InjectedDirectBootstrapResult | null {
  const row = asPlainRecord(value);
  if (!row || typeof row.kind !== "string") {
    return null;
  }
  if (row.kind === "rejected" || row.kind === "unavailable") {
    return hasExactKeys(row, ["kind"]) ? { kind: row.kind } : null;
  }
  return (row.kind === "installed" || row.kind === "existing") &&
    hasExactKeys(row, ["kind", "phase", "revision"]) &&
    isPhase(row.phase) &&
    isRevision(row.revision)
    ? { kind: row.kind, phase: row.phase, revision: row.revision }
    : null;
}

export function parseInjectedDirectControlResult(
  value: unknown
): InjectedDirectControlResult | null {
  const row = asPlainRecord(value);
  if (!row || typeof row.kind !== "string") {
    return null;
  }
  if (row.kind === "unavailable") {
    return hasExactKeys(row, ["kind"]) ? { kind: "unavailable" } : null;
  }
  if (row.kind === "rejected") {
    return hasExactKeys(row, ["kind", "reason"]) &&
      (row.reason === "activation-mismatch" ||
        row.reason === "capability" ||
        row.reason === "invalid-command" ||
        row.reason === "stale")
      ? { kind: "rejected", reason: row.reason }
      : null;
  }
  if (row.kind === "activated" || row.kind === "deactivated") {
    const activationId = parseContentActivationId(row.activationId);
    return hasExactKeys(row, ["kind", "activationId", "revision"]) &&
      activationId &&
      isPositiveRevision(row.revision)
      ? { kind: row.kind, activationId, revision: row.revision }
      : null;
  }
  if (row.kind === "probed") {
    const activationId =
      row.activationId === null ? null : parseContentActivationId(row.activationId);
    return hasExactKeys(row, [
      "kind",
      "phase",
      "revision",
      "activationId",
      "producedThrough",
      "truncatedBefore"
    ]) &&
      isPhase(row.phase) &&
      isRevision(row.revision) &&
      (row.activationId === null || activationId) &&
      (row.phase === "inactive" ? activationId === null : activationId !== null) &&
      isRevision(row.producedThrough) &&
      isRevision(row.truncatedBefore) &&
      row.truncatedBefore <= row.producedThrough
      ? {
          kind: "probed",
          phase: row.phase,
          revision: row.revision,
          activationId,
          producedThrough: row.producedThrough,
          truncatedBefore: row.truncatedBefore
        }
      : null;
  }
  if (row.kind !== "drained") {
    return null;
  }
  const activationId = parseContentActivationId(row.activationId);
  if (
    !hasExactKeys(row, [
      "kind",
      "activationId",
      "revision",
      "events",
      "producedThrough",
      "truncatedBefore",
      "degraded",
      "replayed"
    ]) ||
    !activationId ||
    !isPositiveRevision(row.revision) ||
    !Array.isArray(row.events) ||
    row.events.length > 4_096 ||
    !isRevision(row.producedThrough) ||
    !isRevision(row.truncatedBefore) ||
    row.truncatedBefore > row.producedThrough ||
    typeof row.degraded !== "boolean" ||
    row.degraded !== row.truncatedBefore > 0 ||
    typeof row.replayed !== "boolean"
  ) {
    return null;
  }
  const events = row.events.map((event) => parseDirectReplayEvent(event, activationId));
  return events.every((event) => event !== null)
    ? {
        kind: "drained",
        activationId,
        revision: row.revision,
        events: events as NonNullable<(typeof events)[number]>[],
        producedThrough: row.producedThrough,
        truncatedBefore: row.truncatedBefore,
        degraded: row.degraded,
        replayed: row.replayed
      }
    : null;
}

export function sameMainWorldControllerCapability(
  left: MainWorldControllerHint,
  right: MainWorldControllerHint
): boolean {
  return (
    constantTimeStringEqual(left.secret, right.secret) &&
    constantTimeStringEqual(left.moduleNonce, right.moduleNonce)
  );
}

export function advanceMainWorldControllerHint(
  current: MainWorldControllerHint,
  update: Pick<MainWorldControllerHint, "revision" | "phase" | "activationId">
): MainWorldControllerHint | null {
  if (!isRevision(update.revision) || update.revision < current.revision) {
    return null;
  }
  if (update.revision === current.revision) {
    return update.phase === current.phase && update.activationId === current.activationId
      ? current
      : null;
  }
  return parseMainWorldControllerHint({
    ...current,
    revision: update.revision,
    phase: update.phase,
    activationId: update.activationId
  });
}

function createRandomHex(random: RandomSource | null | undefined, prefix: "" | "m1_"): string {
  if (!random || typeof random.getRandomValues !== "function") {
    throw new Error("Cryptographic randomness is unavailable for MAIN-world control.");
  }
  const bytes = new Uint8Array(DIRECT_RANDOM_BYTES);
  const filled = random.getRandomValues(bytes);
  if (filled !== bytes) {
    throw new Error("Cryptographic randomness did not fill the requested MAIN-world capability.");
  }
  return `${prefix}${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveRevision(value: unknown): value is number {
  return isRevision(value) && value > 0;
}

function isPhase(value: unknown): value is MainWorldControllerPhase {
  return value === "inactive" || value === "active" || value === "drained";
}

function parseDirectReplayEvent(value: unknown, activationId: ContentActivationId) {
  const row = asPlainRecord(value);
  return row &&
    hasExactKeys(row, ["activationId", "seq", "rawType", "payload", "t", "mono"]) &&
    row.activationId === activationId &&
    isPositiveRevision(row.seq) &&
    typeof row.rawType === "string" &&
    row.rawType.length > 0 &&
    asPlainRecord(row.payload) &&
    typeof row.t === "number" &&
    Number.isFinite(row.t) &&
    typeof row.mono === "number" &&
    Number.isFinite(row.mono)
    ? {
        activationId,
        seq: row.seq,
        rawType: row.rawType,
        payload: row.payload as Record<string, unknown>,
        t: row.t,
        mono: row.mono
      }
    : null;
}

function constantTimeStringEqual(left: string, right: string): boolean {
  let mismatch = left.length === right.length ? 0 : 1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
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

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return (
    Object.keys(record).length === expected.size &&
    Object.keys(record).every((key) => expected.has(key))
  );
}
