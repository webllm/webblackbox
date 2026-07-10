const DEFAULT_REDACTION_TOKEN = "[REDACTED]";
const MAX_JSON_DEPTH = 128;
const MAX_JSON_NODES = 100_000;

export type TransformResponseBodyArgs = {
  body: string;
  base64Encoded: boolean;
  mimeType: string | undefined;
  redactPatterns: string[];
  maxBytes: number;
  decodeBase64: (value: string) => Uint8Array;
  redactionToken?: string;
};

export type TransformedResponseBody = {
  originalBytes: Uint8Array;
  sampledBytes: Uint8Array;
  redacted: boolean;
  truncated: boolean;
};

type TextRedactionResult = {
  value: string;
  redacted: boolean;
};

type JsonRedactionState = {
  nodes: number;
  redacted: boolean;
};

/**
 * Decodes, validates, redacts, and byte-caps a textual response body before persistence.
 * Unsupported MIME types and bodies that cannot be parsed or decoded safely are rejected.
 */
export function transformResponseBodyForCapture(
  args: TransformResponseBodyArgs
): TransformedResponseBody | null {
  const mimeType = normalizeMimeType(args.mimeType);

  if (!mimeType || !isTextualMimeType(mimeType)) {
    return null;
  }

  const maxBytes = normalizeMaxBytes(args.maxBytes);

  if (maxBytes === 0) {
    return null;
  }

  const decoded = decodeBodyText(args);

  if (!decoded) {
    return null;
  }

  const patterns = normalizePatterns(args.redactPatterns);
  const redaction = redactTextByMime(
    decoded.text,
    mimeType,
    patterns,
    args.redactionToken ?? DEFAULT_REDACTION_TOKEN
  );

  if (!redaction) {
    return null;
  }

  const candidateBytes = redaction.redacted
    ? new TextEncoder().encode(redaction.value)
    : decoded.bytes;
  const truncated = candidateBytes.byteLength > maxBytes;
  const sampledBytes = truncated ? truncateUtf8(candidateBytes, maxBytes) : candidateBytes;

  if (sampledBytes.byteLength === 0) {
    return null;
  }

  return {
    originalBytes: decoded.bytes,
    sampledBytes,
    redacted: redaction.redacted,
    truncated
  };
}

function decodeBodyText(
  args: TransformResponseBodyArgs
): { bytes: Uint8Array; text: string } | null {
  if (!args.base64Encoded) {
    return {
      bytes: new TextEncoder().encode(args.body),
      text: args.body
    };
  }

  const normalizedBase64 = args.body.replace(/\s/g, "");

  if (!isValidBase64(normalizedBase64)) {
    return null;
  }

  let bytes: Uint8Array;

  try {
    bytes = args.decodeBase64(normalizedBase64);
  } catch {
    return null;
  }

  const expectedLength = decodedBase64Length(normalizedBase64);

  if (bytes.byteLength !== expectedLength) {
    return null;
  }

  try {
    return {
      bytes,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    };
  } catch {
    return null;
  }
}

function redactTextByMime(
  value: string,
  mimeType: string,
  patterns: string[],
  redactionToken: string
): TextRedactionResult | null {
  if (isJsonMimeType(mimeType)) {
    return redactJsonText(value, patterns, redactionToken);
  }

  if (mimeType === "application/x-www-form-urlencoded") {
    return redactFormText(value, patterns, redactionToken);
  }

  // Unstructured text, XML, and executable source cannot be redacted reliably by field name.
  // Preserve explicit capture only when no sensitive patterns are configured; otherwise drop it.
  if (patterns.length > 0) {
    return null;
  }

  return {
    value,
    redacted: false
  };
}

function redactJsonText(
  value: string,
  patterns: string[],
  redactionToken: string
): TextRedactionResult | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stripByteOrderMark(value)) as unknown;
  } catch {
    return null;
  }

  if (patterns.length === 0) {
    return {
      value,
      redacted: false
    };
  }

  const state: JsonRedactionState = {
    nodes: 0,
    redacted: false
  };

  let sanitized: unknown;

  try {
    sanitized = redactJsonValue(parsed, patterns, redactionToken, state, 0);
  } catch {
    return null;
  }

  if (!state.redacted) {
    return {
      value,
      redacted: false
    };
  }

  try {
    return {
      value: JSON.stringify(sanitized),
      redacted: true
    };
  } catch {
    return null;
  }
}

function redactJsonValue(
  value: unknown,
  patterns: string[],
  redactionToken: string,
  state: JsonRedactionState,
  depth: number
): unknown {
  state.nodes += 1;

  if (depth > MAX_JSON_DEPTH || state.nodes > MAX_JSON_NODES) {
    throw new Error("Response JSON exceeds redaction complexity limits");
  }

  if (typeof value === "string") {
    if (containsSensitivePattern(value, patterns)) {
      state.redacted = true;
      return redactionToken;
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry, patterns, redactionToken, state, depth + 1));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const sensitiveField = matchesSensitiveField(key, patterns);
    const nextValue = sensitiveField
      ? redactionToken
      : redactJsonValue(entry, patterns, redactionToken, state, depth + 1);

    if (sensitiveField) {
      state.redacted = true;
    }

    Object.defineProperty(output, key, {
      value: nextValue,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }

  return output;
}

function redactFormText(
  value: string,
  patterns: string[],
  redactionToken: string
): TextRedactionResult | null {
  const entries: Array<[string, string]> = [];

  for (const segment of value.split("&")) {
    if (segment.length === 0) {
      continue;
    }

    const equalsIndex = segment.indexOf("=");
    const encodedKey = equalsIndex >= 0 ? segment.slice(0, equalsIndex) : segment;
    const encodedValue = equalsIndex >= 0 ? segment.slice(equalsIndex + 1) : "";
    const key = decodeFormComponent(encodedKey);
    const entryValue = decodeFormComponent(encodedValue);

    if (key === null || entryValue === null) {
      return null;
    }

    entries.push([key, entryValue]);
  }

  if (patterns.length === 0) {
    return {
      value,
      redacted: false
    };
  }

  let redacted = false;
  const output = new URLSearchParams();

  for (const [key, entryValue] of entries) {
    const sensitive =
      matchesSensitiveField(key, patterns) || containsSensitivePattern(entryValue, patterns);
    output.append(key, sensitive ? redactionToken : entryValue);
    redacted = redacted || sensitive;
  }

  return {
    value: redacted ? output.toString() : value,
    redacted
  };
}

function decodeFormComponent(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

function normalizePatterns(patterns: string[]): string[] {
  const output: string[] = [];

  for (const pattern of patterns) {
    const normalized = pattern.trim().toLowerCase();

    if (normalized && !output.includes(normalized)) {
      output.push(normalized);
    }
  }

  return output;
}

function matchesSensitiveField(field: string, patterns: string[]): boolean {
  const normalizedField = field.toLowerCase();
  return patterns.some((pattern) => normalizedField.includes(pattern));
}

function containsSensitivePattern(value: string, patterns: string[]): boolean {
  const normalizedValue = value.toLowerCase();
  return patterns.some((pattern) => normalizedValue.includes(pattern));
}

function normalizeMimeType(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const [mime] = value.split(";");
  const normalized = mime?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

function isTextualMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    isJsonMimeType(mimeType) ||
    mimeType.includes("xml") ||
    mimeType.includes("javascript") ||
    mimeType.includes("ecmascript") ||
    mimeType === "application/x-www-form-urlencoded"
  );
}

function isJsonMimeType(mimeType: string): boolean {
  return mimeType === "application/json" || mimeType === "text/json" || mimeType.endsWith("+json");
}

function normalizeMaxBytes(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function truncateUtf8(bytes: Uint8Array, maxBytes: number): Uint8Array {
  let end = Math.min(bytes.byteLength, maxBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });

  while (end > 0) {
    const candidate = bytes.slice(0, end);

    try {
      decoder.decode(candidate);
      return candidate;
    } catch {
      end -= 1;
    }
  }

  return new Uint8Array();
}

function stripByteOrderMark(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function isValidBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) {
    return false;
  }

  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function decodedBase64Length(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}
