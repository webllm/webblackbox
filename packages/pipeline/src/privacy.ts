import type {
  CapturePolicy,
  PrivacyDataCategory,
  PrivacyManifest,
  PrivacyManifestCategorySummary,
  PrivacyScannerFinding,
  PrivacyScannerFindingKind,
  PrivacyScannerCoverage,
  PrivacyScannerResult,
  WebBlackboxEvent
} from "@webblackbox/protocol";

import { sha256Hex } from "./hash.js";
import type { StoredBlob } from "./storage.js";

export type PrivacyManifestInput = {
  events: WebBlackboxEvent[];
  blobs: Iterable<PrivacyScanBlob> | AsyncIterable<PrivacyScanBlob>;
  /** Exact total when a bounded scan may stop before consuming the blob iterable. */
  expectedBlobCount?: number;
  capturePolicy?: CapturePolicy;
  encrypted: boolean;
  preEncryption?: boolean;
  transfer?: PrivacyManifest["transfer"];
  generatedAt?: Date;
  scan?: Partial<PrivacyScanOptions>;
};

export type PrivacyScanBlob = Pick<StoredBlob, "bytes" | "hash" | "mime"> & {
  /** Indicates that a bounded reader stopped before returning the complete blob. */
  truncated?: boolean;
  /** Number of source bytes observed before a bounded read stopped. */
  sourceByteLength?: number;
};

export type PrivacyScanOptions = {
  maxTotalBytes: number;
  maxTargetBytes: number;
  maxFindings: number;
  deadlineMs: number;
  stopOnFinding: boolean;
};

type ScanTarget = {
  path: string;
  text: string;
};

type ScannerPattern = {
  kind: PrivacyScannerFindingKind;
  pattern: RegExp;
  validate?: (value: string) => boolean;
};

type ScanIncompleteReason = NonNullable<PrivacyScannerCoverage["incompleteReason"]>;

type EventScanText = {
  text: string;
  byteLength: number;
  truncated: boolean;
  deadlineExceeded: boolean;
};

type BlobScanText = {
  text: string;
  covered: boolean;
  truncated: boolean;
  deadlineExceeded: boolean;
};

const MEBIBYTE = 1024 * 1024;
const DEFAULT_PRIVACY_SCAN_OPTIONS: Readonly<PrivacyScanOptions> = Object.freeze({
  maxTotalBytes: 256 * MEBIBYTE,
  maxTargetBytes: 8 * MEBIBYTE,
  maxFindings: 1_000,
  deadlineMs: 30_000,
  stopOnFinding: false
});

const SCANNER_PATTERNS: ScannerPattern[] = [
  {
    kind: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g
  },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
  },
  {
    kind: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=_-]{16,}\b/gi
  },
  {
    kind: "api-key",
    pattern: /\b(?:api[_-]?key|apikey|x-api-key)["'\s:=]+[A-Za-z0-9._~+/=_-]{16,}\b/gi
  },
  {
    kind: "oauth-code",
    pattern: /\b(?:oauth[_-]?code|code)["'\s:=]+[A-Za-z0-9._~-]{16,}\b/gi
  },
  {
    kind: "session-cookie",
    pattern: /\b(?:session|sessionid|sid|connect\.sid)=[A-Za-z0-9._~%+/=-]{12,}\b/gi
  },
  {
    kind: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
  },
  {
    kind: "phone",
    pattern: /\b(?:\+?1[-.\s]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[-.\s]?\d{3}[-.\s]?\d{4}\b/g
  },
  {
    kind: "credit-card",
    pattern: /\b(?:card|credit[_-]?card|cc|pan)["'\s:=]+(?:\d[ -]*?){13,19}\b/gi,
    validate: hasValidLuhnChecksum
  },
  {
    kind: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g
  },
  {
    kind: "long-secret",
    pattern:
      /\b(?:secret|token|api[_-]?key|private[_-]?key|refresh[_-]?token)["'\s:=]+(?:[a-f0-9]{40,}|[A-Za-z0-9+/]{48,}={0,2})\b/gi
  }
];

export async function buildPrivacyManifest(input: PrivacyManifestInput): Promise<PrivacyManifest> {
  const generatedAt = input.generatedAt ?? new Date();
  const inferredBlobCount = Array.isArray(input.blobs) ? input.blobs.length : undefined;
  const expectedBlobCount = readOptionalNonNegativeSafeInteger(
    input.expectedBlobCount ?? inferredBlobCount,
    "expectedBlobCount"
  );
  if (
    input.expectedBlobCount !== undefined &&
    inferredBlobCount !== undefined &&
    input.expectedBlobCount !== inferredBlobCount
  ) {
    throw new TypeError("Privacy scan expectedBlobCount does not match the blob array length.");
  }
  const { blobCount, scanner } = await scanPrivacyContent(
    input.events,
    input.blobs,
    expectedBlobCount,
    input.preEncryption !== false,
    resolvePrivacyScanOptions(input.scan)
  );

  return {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    effectivePolicy: input.capturePolicy,
    consent: input.capturePolicy?.consent,
    transfer: input.transfer,
    categories: summarizePrivacyCategories(input.events),
    scanner,
    encryption: {
      archive: input.encrypted ? "encrypted" : "plaintext",
      algorithm: input.encrypted ? "AES-GCM" : undefined
    },
    totals: {
      events: input.events.length,
      blobs: blobCount,
      privacyViolations: input.events.filter((event) => event.type === "privacy.violation").length
    }
  };
}

export function assertPrivacyScannerPassed(scanner: PrivacyScannerResult): void {
  if (scanner.status === "blocked") {
    const summary = scanner.findings
      .slice(0, 5)
      .map((finding) => `${finding.kind} in ${finding.path}`)
      .join(", ");
    throw new Error(`Privacy scanner blocked export: ${summary}`);
  }

  if (scanner.coverage?.complete !== true) {
    throw new Error(
      `Privacy scanner did not complete export analysis (${scanner.coverage?.incompleteReason ?? "unknown reason"}).`
    );
  }
}

async function scanPrivacyContent(
  events: WebBlackboxEvent[],
  blobs: Iterable<PrivacyScanBlob> | AsyncIterable<PrivacyScanBlob>,
  expectedBlobCount: number | undefined,
  preEncryption: boolean,
  options: PrivacyScanOptions
): Promise<{ blobCount: number; scanner: PrivacyScannerResult }> {
  const findings: PrivacyScannerFinding[] = [];
  const coverage: PrivacyScannerCoverage = {
    complete: true,
    scannedEventCount: 0,
    scannedBlobCount: 0,
    opaqueBlobCount: 0,
    inspectedBytes: 0
  };
  const deadline = monotonicNow() + options.deadlineMs;
  let blobCount = 0;
  let halted = false;

  const markIncomplete = (reason: ScanIncompleteReason, halt = false) => {
    coverage.complete = false;
    coverage.incompleteReason ??= reason;
    halted ||= halt;
  };

  for (const event of events) {
    if (deadlineExceeded(deadline)) {
      markIncomplete("deadline", true);
      break;
    }

    const extracted = extractEventScanText(event, options.maxTargetBytes, deadline);
    if (extracted.deadlineExceeded) {
      markIncomplete("deadline", true);
      break;
    }
    const eventFullyExtracted = !extracted.truncated;
    if (!eventFullyExtracted) {
      markIncomplete("target-byte-limit");
    }

    const targetBytes = extracted.byteLength;
    if (coverage.inspectedBytes + targetBytes > options.maxTotalBytes) {
      markIncomplete("total-byte-limit", true);
      break;
    }
    coverage.inspectedBytes += targetBytes;

    const stopReason = await scanPrivacyTarget(
      { path: `event:${event.id}`, text: extracted.text },
      findings,
      options,
      deadline
    );
    if (stopReason) {
      markIncomplete(stopReason, true);
      break;
    }
    if (eventFullyExtracted) {
      coverage.scannedEventCount += 1;
    }
  }

  if (!halted || expectedBlobCount === undefined) {
    const iterator = toAsyncIterator(blobs);
    let iteratorFinished = false;
    try {
      while (!halted) {
        const next = await readIteratorBeforeDeadline(iterator, deadline);
        if (next.timedOut) {
          markIncomplete("deadline", true);
          break;
        }
        if (next.result.done) {
          iteratorFinished = true;
          break;
        }
        const blob = next.result.value;
        blobCount += 1;
        if (expectedBlobCount !== undefined && blobCount > expectedBlobCount) {
          throw new Error(
            `Privacy scan blob source exceeded expected count ${expectedBlobCount}: received at least ${blobCount}.`
          );
        }
        if (deadlineExceeded(deadline)) {
          markIncomplete("deadline", true);
          break;
        }
        if (!isPrivacyScannerTextMime(blob.mime)) {
          coverage.opaqueBlobCount += 1;
          continue;
        }

        const sourceByteLength = blob.sourceByteLength ?? blob.bytes.byteLength;
        if (
          blob.truncated ||
          blob.bytes.byteLength > options.maxTargetBytes ||
          sourceByteLength > options.maxTargetBytes
        ) {
          coverage.opaqueBlobCount += 1;
          markIncomplete("target-byte-limit");
          continue;
        }

        const decoded = decodeBlobForScanning(blob, options.maxTargetBytes, deadline);
        const bounded = boundScanText(decoded.text, options.maxTargetBytes);
        if (decoded.deadlineExceeded) {
          coverage.opaqueBlobCount += 1;
          markIncomplete("deadline", true);
          break;
        }
        if (!decoded.covered || decoded.truncated || bounded.truncated) {
          coverage.opaqueBlobCount += 1;
          markIncomplete(
            decoded.covered && (decoded.truncated || bounded.truncated)
              ? "target-byte-limit"
              : "decode-failed"
          );
        } else {
          coverage.scannedBlobCount += 1;
        }

        if (deadlineExceeded(deadline)) {
          if (decoded.covered && !decoded.truncated && !bounded.truncated) {
            coverage.scannedBlobCount -= 1;
            coverage.opaqueBlobCount += 1;
          }
          markIncomplete("deadline", true);
          break;
        }
        if (coverage.inspectedBytes + bounded.byteLength > options.maxTotalBytes) {
          if (decoded.covered && !decoded.truncated && !bounded.truncated) {
            coverage.scannedBlobCount -= 1;
            coverage.opaqueBlobCount += 1;
          }
          markIncomplete("total-byte-limit", true);
          break;
        }
        coverage.inspectedBytes += bounded.byteLength;

        const stopReason = await scanPrivacyTarget(
          { path: `blob:${blob.hash}`, text: bounded.text },
          findings,
          options,
          deadline
        );
        if (stopReason) {
          markIncomplete(stopReason, true);
        }
      }
    } finally {
      if (!iteratorFinished) {
        closeIteratorWithoutWaiting(iterator);
      }
    }
  }

  if (expectedBlobCount !== undefined) {
    if (!halted && blobCount !== expectedBlobCount) {
      throw new Error(
        `Privacy scan blob source count mismatch: expected ${expectedBlobCount}, received ${blobCount}.`
      );
    }
    if (blobCount > expectedBlobCount) {
      throw new Error(
        `Privacy scan blob source exceeded expected count ${expectedBlobCount}: received at least ${blobCount}.`
      );
    }
    blobCount = expectedBlobCount;
  }

  return {
    blobCount,
    scanner: {
      scannedAt: new Date().toISOString(),
      preEncryption,
      status: findings.length > 0 ? "blocked" : "passed",
      findings,
      coverage
    }
  };
}

type DeadlineIteratorResult<T> =
  | { timedOut: true }
  | { timedOut: false; result: IteratorResult<T> };

function toAsyncIterator<T>(source: Iterable<T> | AsyncIterable<T>): AsyncIterator<T> {
  const asyncIterator = (source as AsyncIterable<T>)[Symbol.asyncIterator]?.();
  if (asyncIterator) {
    return asyncIterator;
  }

  const iterator = (source as Iterable<T>)[Symbol.iterator]();
  return {
    next: async () => iterator.next(),
    return: iterator.return
      ? async () => iterator.return?.() ?? { done: true, value: undefined }
      : undefined
  };
}

async function readIteratorBeforeDeadline<T>(
  iterator: AsyncIterator<T>,
  deadline: number
): Promise<DeadlineIteratorResult<T>> {
  const remainingMs = deadline - monotonicNow();
  if (remainingMs <= 0) {
    return { timedOut: true };
  }

  const nextPromise = Promise.resolve(iterator.next());
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<DeadlineIteratorResult<T>>((resolvePromise) => {
    timeoutId = setTimeout(() => resolvePromise({ timedOut: true }), Math.max(1, remainingMs));
  });
  const result = await Promise.race<DeadlineIteratorResult<T>>([
    nextPromise.then((next) => ({ timedOut: false, result: next })),
    timeoutPromise
  ]);
  if (timeoutId !== undefined) {
    clearTimeout(timeoutId);
  }
  if (result.timedOut) {
    void nextPromise.catch(() => undefined);
  }
  return result;
}

function closeIteratorWithoutWaiting<T>(iterator: AsyncIterator<T>): void {
  try {
    const closing = iterator.return?.();
    if (closing) {
      void Promise.resolve(closing).catch(() => undefined);
    }
  } catch {
    // Deadline enforcement must not wait for or surface iterator cleanup failures.
  }
}

async function scanPrivacyTarget(
  target: ScanTarget,
  findings: PrivacyScannerFinding[],
  options: PrivacyScanOptions,
  deadline: number
): Promise<ScanIncompleteReason | null> {
  if (!target.text) {
    return null;
  }

  for (const scanner of SCANNER_PATTERNS) {
    if (deadlineExceeded(deadline)) {
      return "deadline";
    }
    const matches = collectMatches(target.text, scanner);

    if (matches.length === 0) {
      continue;
    }

    findings.push({
      kind: scanner.kind,
      severity: "high",
      path: target.path,
      matchCount: matches.length,
      sampleSha256: await sha256Hex(matches[0] ?? "")
    });

    if (options.stopOnFinding || findings.length >= options.maxFindings) {
      return "finding-limit";
    }
  }

  return null;
}

function collectMatches(text: string, scanner: ScannerPattern): string[] {
  const output: string[] = [];

  for (const match of text.matchAll(scanner.pattern)) {
    const value = match[0];

    if (!value || scanner.validate?.(value) === false) {
      continue;
    }

    output.push(value);

    if (output.length >= 25) {
      break;
    }
  }

  return output;
}

function summarizePrivacyCategories(events: WebBlackboxEvent[]): PrivacyManifestCategorySummary[] {
  const summaries = new Map<PrivacyDataCategory, PrivacyManifestCategorySummary>();

  for (const event of events) {
    const privacy = event.privacy;

    if (!privacy) {
      continue;
    }

    const summary =
      summaries.get(privacy.category) ??
      ({
        category: privacy.category,
        events: 0,
        low: 0,
        medium: 0,
        high: 0,
        redacted: 0,
        unredacted: 0
      } satisfies PrivacyManifestCategorySummary);

    summary.events += 1;
    summary[privacy.sensitivity] += 1;

    if (privacy.redacted) {
      summary.redacted += 1;
    } else {
      summary.unredacted += 1;
    }

    summaries.set(privacy.category, summary);
  }

  return [...summaries.values()].sort((left, right) => left.category.localeCompare(right.category));
}

function decodeBlobForScanning(
  blob: PrivacyScanBlob,
  maxTargetBytes: number,
  deadline: number
): BlobScanText {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(blob.bytes);
  } catch {
    return { text: "", covered: false, truncated: false, deadlineExceeded: false };
  }

  if (blob.mime.toLowerCase().includes("json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return { text, covered: false, truncated: false, deadlineExceeded: false };
    }

    const semanticBudget = Math.max(0, maxTargetBytes - blob.bytes.byteLength - 1);
    const semantic = extractStructuredScanText(parsed, semanticBudget, deadline);
    return {
      text: semantic.text.length > 0 ? `${text}\0${semantic.text}` : text,
      covered: true,
      truncated: semantic.truncated,
      deadlineExceeded: semantic.deadlineExceeded
    };
  }

  return { text, covered: true, truncated: false, deadlineExceeded: false };
}

export function isPrivacyScannerTextMime(mime: string): boolean {
  const normalized = mime.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript") ||
    normalized.includes("x-www-form-urlencoded")
  );
}

function extractEventScanText(
  event: WebBlackboxEvent,
  maxTargetBytes: number,
  deadline: number
): EventScanText {
  return extractStructuredScanText(event, maxTargetBytes, deadline);
}

function extractStructuredScanText(
  root: unknown,
  maxTargetBytes: number,
  deadline: number
): EventScanText {
  const strings: string[] = [];
  const stack: Array<{ value: unknown; key?: string; emitKey?: boolean }> = [{ value: root }];
  const seen = new WeakSet<object>();
  const encoder = new TextEncoder();
  let byteLength = 0;
  let visited = 0;

  const append = (fragment: string): boolean => {
    const separatorBytes = strings.length > 0 ? 1 : 0;
    const remaining = maxTargetBytes - byteLength - separatorBytes;
    if (remaining < 0) {
      return false;
    }

    const encoded = encoder.encode(fragment);
    if (encoded.byteLength <= remaining) {
      strings.push(fragment);
      byteLength += separatorBytes + encoded.byteLength;
      return true;
    }
    if (remaining === 0) {
      if (separatorBytes > 0) {
        strings.push("");
        byteLength += separatorBytes;
      }
      return false;
    }

    const target = new Uint8Array(remaining);
    const { read, written } = encoder.encodeInto(fragment, target);
    strings.push(fragment.slice(0, read));
    byteLength += separatorBytes + written;
    return read === fragment.length;
  };

  while (stack.length > 0) {
    visited += 1;
    if (visited % 64 === 0 && deadlineExceeded(deadline)) {
      return {
        text: strings.join("\0"),
        byteLength,
        truncated: true,
        deadlineExceeded: true
      };
    }

    const current = stack.pop();
    const value = current?.value;
    if (typeof value === "string") {
      const target =
        current?.key === undefined
          ? JSON.stringify(value)
          : `${JSON.stringify(current.key)}:${JSON.stringify(value)}`;
      if (!append(target)) {
        return { text: strings.join("\0"), byteLength, truncated: true, deadlineExceeded: false };
      }
      continue;
    }
    if (current?.key !== undefined && current.emitKey && !append(JSON.stringify(current.key))) {
      return { text: strings.join("\0"), byteLength, truncated: true, deadlineExceeded: false };
    }
    if (!value || typeof value !== "object" || seen.has(value)) {
      continue;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index], key: current?.key, emitKey: false });
      }
      continue;
    }
    const entries = Object.entries(value);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry) {
        stack.push({ value: entry[1], key: entry[0], emitKey: true });
      }
    }
  }

  return { text: strings.join("\0"), byteLength, truncated: false, deadlineExceeded: false };
}

function resolvePrivacyScanOptions(input: Partial<PrivacyScanOptions> = {}): PrivacyScanOptions {
  return {
    maxTotalBytes: readPositiveSafeInteger(
      input.maxTotalBytes,
      DEFAULT_PRIVACY_SCAN_OPTIONS.maxTotalBytes,
      "maxTotalBytes"
    ),
    maxTargetBytes: readPositiveSafeInteger(
      input.maxTargetBytes,
      DEFAULT_PRIVACY_SCAN_OPTIONS.maxTargetBytes,
      "maxTargetBytes"
    ),
    maxFindings: readPositiveSafeInteger(
      input.maxFindings,
      DEFAULT_PRIVACY_SCAN_OPTIONS.maxFindings,
      "maxFindings"
    ),
    deadlineMs: readPositiveSafeInteger(
      input.deadlineMs,
      DEFAULT_PRIVACY_SCAN_OPTIONS.deadlineMs,
      "deadlineMs"
    ),
    stopOnFinding: input.stopOnFinding ?? DEFAULT_PRIVACY_SCAN_OPTIONS.stopOnFinding
  };
}

function readPositiveSafeInteger(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`Privacy scan option '${label}' must be a positive safe integer.`);
  }
  return resolved;
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function deadlineExceeded(deadline: number): boolean {
  return monotonicNow() >= deadline;
}

function boundScanText(
  text: string,
  maxBytes: number
): { text: string; byteLength: number; truncated: boolean } {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) {
    return { text, byteLength: encoded.byteLength, truncated: false };
  }

  const target = new Uint8Array(maxBytes);
  const { read, written } = new TextEncoder().encodeInto(text, target);
  return { text: text.slice(0, read), byteLength: written, truncated: true };
}

function readOptionalNonNegativeSafeInteger(
  value: number | undefined,
  label: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Privacy scan option '${label}' must be a non-negative safe integer.`);
  }
  return value;
}

function hasValidLuhnChecksum(value: string): boolean {
  const digits = value.replace(/\D/g, "");

  if (digits.length < 13 || digits.length > 19) {
    return false;
  }

  let sum = 0;
  let doubleNext = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);

    if (!Number.isInteger(digit)) {
      return false;
    }

    if (doubleNext) {
      digit *= 2;

      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    doubleNext = !doubleNext;
  }

  return sum % 10 === 0;
}
