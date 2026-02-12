import type { RedactionProfile } from "@webblackbox/protocol";

const REDACTED = "[REDACTED]";

function hashValue(value: string): string {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return `h${Math.abs(hash).toString(16)}`;
}

export function redactPayload(input: unknown, profile: RedactionProfile): unknown {
  if (Array.isArray(input)) {
    return input.map((item) => redactPayload(item, profile));
  }

  if (input !== null && typeof input === "object") {
    const source = input as Record<string, unknown>;
    const output: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(source)) {
      const normalizedKey = key.toLowerCase();

      if (profile.redactHeaders.includes(normalizedKey) || isSensitiveKey(normalizedKey, profile)) {
        output[key] =
          profile.hashSensitiveValues && typeof value === "string" ? hashValue(value) : REDACTED;
        continue;
      }

      if (normalizedKey === "headers" && value !== null && typeof value === "object") {
        output[key] = redactHeaders(value as Record<string, unknown>, profile);
        continue;
      }

      if (
        (normalizedKey === "value" || normalizedKey === "text") &&
        shouldMaskBySelector(source, profile)
      ) {
        output[key] =
          typeof value === "string" ? maskString(value, profile.hashSensitiveValues) : REDACTED;
        continue;
      }

      output[key] = redactPayload(value, profile);
    }

    return output;
  }

  if (typeof input === "string" && containsSensitivePattern(input, profile)) {
    return maskString(input, profile.hashSensitiveValues);
  }

  return input;
}

function redactHeaders(
  headers: Record<string, unknown>,
  profile: RedactionProfile
): Record<string, unknown> {
  const next: Record<string, unknown> = {};

  for (const [header, value] of Object.entries(headers)) {
    const normalized = header.toLowerCase();

    if (profile.redactHeaders.includes(normalized)) {
      if (typeof value === "string") {
        next[header] = profile.hashSensitiveValues ? hashValue(value) : REDACTED;
      } else {
        next[header] = REDACTED;
      }
      continue;
    }

    next[header] = value;
  }

  return next;
}

function isSensitiveKey(key: string, profile: RedactionProfile): boolean {
  return profile.redactBodyPatterns.some((pattern) => key.includes(pattern.toLowerCase()));
}

function containsSensitivePattern(value: string, profile: RedactionProfile): boolean {
  const lowered = value.toLowerCase();
  return profile.redactBodyPatterns.some((pattern) => lowered.includes(pattern.toLowerCase()));
}

function shouldMaskBySelector(source: Record<string, unknown>, profile: RedactionProfile): boolean {
  const selector = source.selector;

  if (typeof selector !== "string") {
    return false;
  }

  return profile.blockedSelectors.some((blocked) => selector.includes(blocked));
}

function maskString(value: string, hashed: boolean): string {
  if (hashed) {
    return hashValue(value);
  }

  return REDACTED;
}
