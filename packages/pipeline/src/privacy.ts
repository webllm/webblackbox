import type {
  CapturePolicy,
  PrivacyDataCategory,
  PrivacyManifest,
  PrivacyManifestCategorySummary,
  PrivacyScannerFinding,
  PrivacyScannerFindingKind,
  PrivacyScannerResult,
  WebBlackboxEvent
} from "@webblackbox/protocol";

import { sha256Hex } from "./hash.js";
import type { StoredBlob } from "./storage.js";

export type PrivacyManifestInput = {
  events: WebBlackboxEvent[];
  blobs: StoredBlob[];
  capturePolicy?: CapturePolicy;
  encrypted: boolean;
  transfer?: PrivacyManifest["transfer"];
  generatedAt?: Date;
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
  const scanner = await scanPrivacyTargets([
    ...input.events.map((event) => ({
      path: `event:${event.id}`,
      text: extractEventScanText(event)
    })),
    ...input.blobs.map((blob) => ({
      path: `blob:${blob.hash}`,
      text: decodeBlobForScanning(blob)
    }))
  ]);

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
      blobs: input.blobs.length,
      privacyViolations: input.events.filter((event) => event.type === "privacy.violation").length
    }
  };
}

function extractEventScanText(event: WebBlackboxEvent): string {
  if (event.type === "meta.config") {
    return "";
  }

  const strings: string[] = [];
  collectStringLeaves(event.data, strings);
  collectStringLeaves(event.ref, strings);
  collectStringLeaves(event.cdp, strings);
  collectStringLeaves(event.frame, strings);
  return strings.join("\n");
}

function collectStringLeaves(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringLeaves(item, output);
    }
    return;
  }

  for (const item of Object.values(value)) {
    collectStringLeaves(item, output);
  }
}

export function assertPrivacyScannerPassed(scanner: PrivacyScannerResult): void {
  if (scanner.status === "blocked") {
    const summary = scanner.findings
      .slice(0, 5)
      .map((finding) => `${finding.kind} in ${finding.path}`)
      .join(", ");
    throw new Error(`Privacy scanner blocked export: ${summary}`);
  }
}

async function scanPrivacyTargets(targets: ScanTarget[]): Promise<PrivacyScannerResult> {
  const findings: PrivacyScannerFinding[] = [];

  for (const target of targets) {
    if (!target.text) {
      continue;
    }

    for (const scanner of SCANNER_PATTERNS) {
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
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    preEncryption: true,
    status: findings.length > 0 ? "blocked" : "passed",
    findings
  };
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

function decodeBlobForScanning(blob: StoredBlob): string {
  if (!isLikelyTextBlob(blob.mime)) {
    return "";
  }

  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(blob.bytes);
  } catch {
    return "";
  }
}

function isLikelyTextBlob(mime: string): boolean {
  const normalized = mime.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript") ||
    normalized.includes("x-www-form-urlencoded")
  );
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
