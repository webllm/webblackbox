import type { RedactionProfile } from "@webblackbox/protocol";

const REDACTED = "[REDACTED]";
// Redaction runs on the synchronous ingest hot path (service worker + content/injected contexts).
// We intentionally keep hashing sync to avoid async pipeline stalls from crypto.subtle.digest.
const SHA_256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function hashValue(value: string): string {
  return sha256Hex(value);
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

      if (isCookieField(normalizedKey)) {
        output[key] = redactCookieField(value, profile, normalizedKey);
        continue;
      }

      if (
        (normalizedKey === "value" || normalizedKey === "text") &&
        (shouldMaskBySelector(source, profile) || shouldMaskByCookieName(source, profile))
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

    if (typeof value === "string" && (normalized === "cookie" || normalized === "set-cookie")) {
      next[header] = redactCookieHeaderValue(value, profile, normalized);
      continue;
    }

    next[header] = redactPayload(value, profile);
  }

  return next;
}

function isCookieField(key: string): boolean {
  return key === "cookie" || key === "cookies" || key === "set-cookie" || key === "setcookie";
}

function redactCookieField(value: unknown, profile: RedactionProfile, fieldName: string): unknown {
  if (typeof value === "string") {
    return redactCookieHeaderValue(value, profile, fieldName);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactCookieField(entry, profile, fieldName));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const cookieName = readCookieName(source);
  const shouldMaskValue = cookieName ? shouldRedactCookieName(cookieName, profile) : false;

  for (const [key, entry] of Object.entries(source)) {
    const normalizedKey = key.toLowerCase();

    if (shouldMaskValue && (normalizedKey === "value" || normalizedKey === "text")) {
      output[key] =
        typeof entry === "string" ? maskString(entry, profile.hashSensitiveValues) : REDACTED;
      continue;
    }

    output[key] = redactPayload(entry, profile);
  }

  return output;
}

function redactCookieHeaderValue(
  value: string,
  profile: RedactionProfile,
  headerName: string
): string {
  if (profile.redactCookieNames.length === 0) {
    return value;
  }

  if (headerName === "cookie") {
    const parts = value.split(";");

    return parts
      .map((entry) => {
        const trimmed = entry.trim();
        const equalsIndex = trimmed.indexOf("=");

        if (equalsIndex <= 0) {
          return trimmed;
        }

        const cookieName = trimmed.slice(0, equalsIndex).trim();

        if (!shouldRedactCookieName(cookieName, profile)) {
          return trimmed;
        }

        const rawValue = trimmed.slice(equalsIndex + 1);
        return `${cookieName}=${maskString(rawValue, profile.hashSensitiveValues)}`;
      })
      .join("; ");
  }

  const lines = value
    .split(/\r?\n/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const source = lines.length > 0 ? lines : [value];

  return source
    .map((line) => {
      const semiIndex = line.indexOf(";");
      const firstPair = semiIndex >= 0 ? line.slice(0, semiIndex) : line;
      const equalsIndex = firstPair.indexOf("=");

      if (equalsIndex <= 0) {
        return line;
      }

      const cookieName = firstPair.slice(0, equalsIndex).trim();

      if (!shouldRedactCookieName(cookieName, profile)) {
        return line;
      }

      const cookieValue = firstPair.slice(equalsIndex + 1).trim();
      const masked = `${cookieName}=${maskString(cookieValue, profile.hashSensitiveValues)}`;
      return semiIndex >= 0 ? `${masked}${line.slice(semiIndex)}` : masked;
    })
    .join("\n");
}

function readCookieName(source: Record<string, unknown>): string | null {
  const candidates = [source.name, source.cookieName, source.key];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function shouldRedactCookieName(name: string, profile: RedactionProfile): boolean {
  const normalizedName = name.trim().toLowerCase();

  if (!normalizedName) {
    return false;
  }

  return profile.redactCookieNames.some((entry) => entry.trim().toLowerCase() === normalizedName);
}

function shouldMaskByCookieName(
  source: Record<string, unknown>,
  profile: RedactionProfile
): boolean {
  const cookieName = readCookieName(source);

  if (!cookieName) {
    return false;
  }

  const cookieSignals = ["domain", "path", "samesite", "httponly", "secure", "expires", "size"];
  const keys = Object.keys(source).map((key) => key.toLowerCase());
  const looksLikeCookieRecord =
    keys.some((key) => key.includes("cookie")) ||
    cookieSignals.some((signal) => keys.includes(signal));

  if (!looksLikeCookieRecord) {
    return false;
  }

  return shouldRedactCookieName(cookieName, profile);
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

function sha256Hex(value: string): string {
  const message = new TextEncoder().encode(value);
  const bitLength = message.length * 8;
  const totalLength = ((message.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(totalLength);
  padded.set(message);
  padded[message.length] = 0x80;

  const view = new DataView(padded.buffer);
  const highBits = Math.floor(bitLength / 0x100000000);
  const lowBits = bitLength >>> 0;
  view.setUint32(padded.length - 8, highBits);
  view.setUint32(padded.length - 4, lowBits);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const words = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }

    for (let index = 16; index < 64; index += 1) {
      const s0 =
        rightRotate(words[index - 15]!, 7) ^
        rightRotate(words[index - 15]!, 18) ^
        (words[index - 15]! >>> 3);
      const s1 =
        rightRotate(words[index - 2]!, 17) ^
        rightRotate(words[index - 2]!, 19) ^
        (words[index - 2]! >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + SHA_256_K[index]! + words[index]!) >>> 0;
      const sum0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((part) => part.toString(16).padStart(8, "0"))
    .join("");
}

function rightRotate(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}
