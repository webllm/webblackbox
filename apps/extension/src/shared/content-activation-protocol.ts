const READY_ID_PATTERN = /^r1_[0-9a-f]{64}$/u;
const ACTIVATION_ID_PATTERN = /^a1_[0-9a-f]{64}$/u;
const EVENT_BATCH_ID_PATTERN = /^b1_[0-9a-f]{64}$/u;
const CONTENT_ID_RANDOM_BYTES = 32;

declare const contentReadyIdBrand: unique symbol;
declare const contentActivationIdBrand: unique symbol;
declare const contentEventBatchIdBrand: unique symbol;

export type ContentReadyId = string & {
  readonly [contentReadyIdBrand]: "ContentReadyId";
};

export type ContentActivationId = string & {
  readonly [contentActivationIdBrand]: "ContentActivationId";
};

export type ContentEventBatchId = string & {
  readonly [contentEventBatchIdBrand]: "ContentEventBatchId";
};

export type RandomValuesProvider = {
  getRandomValues(bytes: Uint8Array): Uint8Array;
};

/**
 * A detached, accessor-free record copied only from exact own data
 * properties. Its null prototype prevents inherited-property confusion.
 */
export type PlainOwnDataRecord = Readonly<Record<string, unknown>>;

export function createContentReadyId(
  random: RandomValuesProvider = requireRandomValuesProvider()
): ContentReadyId {
  return `r1_${createRandomHex(random)}` as ContentReadyId;
}

export function createContentActivationId(
  random: RandomValuesProvider = requireRandomValuesProvider()
): ContentActivationId {
  return `a1_${createRandomHex(random)}` as ContentActivationId;
}

export function createContentEventBatchId(
  random: RandomValuesProvider = requireRandomValuesProvider()
): ContentEventBatchId {
  return `b1_${createRandomHex(random)}` as ContentEventBatchId;
}

export function parseContentReadyId(value: unknown): ContentReadyId | null {
  return typeof value === "string" && READY_ID_PATTERN.test(value)
    ? (value as ContentReadyId)
    : null;
}

export function parseContentActivationId(value: unknown): ContentActivationId | null {
  return typeof value === "string" && ACTIVATION_ID_PATTERN.test(value)
    ? (value as ContentActivationId)
    : null;
}

export function parseContentEventBatchId(value: unknown): ContentEventBatchId | null {
  return typeof value === "string" && EVENT_BATCH_ID_PATTERN.test(value)
    ? (value as ContentEventBatchId)
    : null;
}

export function isContentReadyId(value: unknown): value is ContentReadyId {
  return parseContentReadyId(value) !== null;
}

export function isContentActivationId(value: unknown): value is ContentActivationId {
  return parseContentActivationId(value) !== null;
}

/**
 * Parses untrusted message input without reading properties through ordinary
 * access. Accessors, symbols, inherited/class instances, missing keys, and
 * extra keys all fail closed. Getter functions are never invoked.
 */
export function parseExactPlainOwnDataRecord(
  value: unknown,
  expectedKeys: readonly string[]
): PlainOwnDataRecord | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }

    if (!hasUniqueStringKeys(expectedKeys)) {
      throw new Error("Expected own-data keys must be unique non-empty strings.");
    }

    const ownKeys = Reflect.ownKeys(value);

    if (ownKeys.length !== expectedKeys.length || ownKeys.some((key) => typeof key !== "string")) {
      return null;
    }

    const expected = new Set(expectedKeys);

    if (ownKeys.some((key) => typeof key !== "string" || !expected.has(key))) {
      return null;
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const detached = Object.create(null) as Record<string, unknown>;

    for (const key of expectedKeys) {
      const descriptor = descriptors[key];

      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        return null;
      }

      Object.defineProperty(detached, key, {
        configurable: false,
        enumerable: true,
        value: descriptor.value,
        writable: false
      });
    }

    return Object.freeze(detached);
  } catch {
    return null;
  }
}

export function parseExactContentReadyIdRecord(
  value: unknown,
  expectedKeys: readonly string[] = ["readyId"]
): (PlainOwnDataRecord & { readonly readyId: ContentReadyId }) | null {
  const record = parseExactPlainOwnDataRecord(value, expectedKeys);

  if (!record || !Object.hasOwn(record, "readyId")) {
    return null;
  }

  const readyId = parseContentReadyId(record.readyId);
  return readyId ? Object.freeze({ ...record, readyId }) : null;
}

export function parseExactContentActivationIdRecord(
  value: unknown,
  expectedKeys: readonly string[] = ["activationId"]
): (PlainOwnDataRecord & { readonly activationId: ContentActivationId }) | null {
  const record = parseExactPlainOwnDataRecord(value, expectedKeys);

  if (!record || !Object.hasOwn(record, "activationId")) {
    return null;
  }

  const activationId = parseContentActivationId(record.activationId);
  return activationId ? Object.freeze({ ...record, activationId }) : null;
}

function requireRandomValuesProvider(): RandomValuesProvider {
  const random = globalThis.crypto;

  if (!random || typeof random.getRandomValues !== "function") {
    throw new Error("Cryptographic randomness is unavailable for content activation ids.");
  }

  return random;
}

function createRandomHex(random: RandomValuesProvider): string {
  const bytes = new Uint8Array(CONTENT_ID_RANDOM_BYTES);
  const filled = random.getRandomValues(bytes);

  if (filled !== bytes || bytes.byteLength !== CONTENT_ID_RANDOM_BYTES) {
    throw new Error("The random-values provider returned an invalid activation id buffer.");
  }

  let hex = "";

  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
}

function hasUniqueStringKeys(keys: readonly string[]): boolean {
  return (
    keys.every((key) => typeof key === "string" && key.length > 0) &&
    new Set(keys).size === keys.length
  );
}
