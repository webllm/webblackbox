import type { CapturePolicy, RedactionProfile, SessionMetadata } from "@webblackbox/protocol";

export type PipelineStartIdentityInput = Readonly<{
  sid: string;
  session: SessionMetadata;
  redactionProfile?: RedactionProfile;
  capturePolicy?: CapturePolicy;
}>;

/** Canonicalizes the full immutable pipeline start contract for exact reconnect validation. */
export function createPipelineStartIdentity(input: PipelineStartIdentityInput): string {
  if (input.sid.length === 0 || input.session.sid !== input.sid) {
    throw new Error("Pipeline start session identity does not match its request.");
  }

  return canonicalJson({
    sid: input.sid,
    session: {
      sid: input.session.sid,
      tabId: input.session.tabId,
      startedAt: input.session.startedAt,
      mode: input.session.mode
    },
    redactionProfile: input.redactionProfile,
    capturePolicy: input.capturePolicy
  });
}

export function assertMatchingPipelineStartIdentity(
  sid: string,
  existing: string | undefined,
  candidate: string
): void {
  if (existing !== candidate) {
    throw new Error(`Pipeline start contract changed for surviving session: ${sid}`);
  }
}

function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  let entries = 0;

  const visit = (candidate: unknown, depth: number): unknown => {
    if (depth > 32 || entries > 20_000) {
      throw new Error("Pipeline start identity exceeds canonicalization limits.");
    }
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new Error("Pipeline start identity contains a non-finite number.");
      }
      return candidate;
    }
    if (candidate === undefined) {
      return undefined;
    }
    if (typeof candidate !== "object") {
      throw new Error("Pipeline start identity contains a non-serializable value.");
    }
    if (seen.has(candidate)) {
      throw new Error("Pipeline start identity contains a cycle.");
    }
    seen.add(candidate);
    entries += 1;

    try {
      if (Array.isArray(candidate)) {
        return candidate.map((entry) => {
          const normalized = visit(entry, depth + 1);
          if (normalized === undefined) {
            throw new Error("Pipeline start identity contains an undefined array entry.");
          }
          return normalized;
        });
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Pipeline start identity contains a non-plain object.");
      }
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(candidate).sort()) {
        const entry = visit((candidate as Record<string, unknown>)[key], depth + 1);
        if (entry !== undefined) {
          normalized[key] = entry;
        }
      }
      return normalized;
    } finally {
      seen.delete(candidate);
    }
  };

  return JSON.stringify(visit(value, 0));
}
