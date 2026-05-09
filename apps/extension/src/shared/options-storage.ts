import {
  DEFAULT_RECORDER_CONFIG,
  type CapturePolicy,
  type RecorderConfig
} from "@webblackbox/protocol";

export const OPTIONS_STORAGE_VERSION = 1;
export const ENTERPRISE_POLICY_STORAGE_KEY = "enterprisePolicy";

export type EnterpriseRecorderPolicy = {
  siteAllowlist: string[];
  siteDenylist: string[];
  dataCategoryCaps: Partial<CapturePolicy["categories"]>;
  disableLabMode: boolean;
  retention: {
    localTtlMs?: number;
    shareTtlMs?: number;
  };
};

type StoredRecorderConfigRow = {
  optionsVersion?: unknown;
  sampling?: unknown;
};

export function migrateStoredRecorderConfig<T extends StoredRecorderConfigRow>(
  record: T
): T & { optionsVersion: number } {
  const version = normalizeStoredVersion(record.optionsVersion);

  if (version >= OPTIONS_STORAGE_VERSION) {
    return record as T & { optionsVersion: number };
  }

  const sampling = asRecord(record.sampling);

  if (!sampling) {
    return {
      ...record,
      optionsVersion: OPTIONS_STORAGE_VERSION
    };
  }

  const nextSampling = { ...sampling };

  if (sampling.screenshotIdleMs === 0) {
    nextSampling.screenshotIdleMs = DEFAULT_RECORDER_CONFIG.sampling.screenshotIdleMs;
  }

  return {
    ...record,
    sampling: nextSampling,
    optionsVersion: OPTIONS_STORAGE_VERSION
  };
}

export function normalizeEnterprisePolicy(value: unknown): EnterpriseRecorderPolicy {
  const record = asRecord(value);

  return {
    siteAllowlist: normalizeStringList(record?.siteAllowlist),
    siteDenylist: normalizeStringList(record?.siteDenylist),
    dataCategoryCaps: normalizeDataCategoryCaps(record?.dataCategoryCaps),
    disableLabMode: record?.disableLabMode === true,
    retention: normalizeRetentionPolicy(record?.retention)
  };
}

export function isEnterpriseOriginAllowed(
  origin: string,
  policy: EnterpriseRecorderPolicy
): boolean {
  const normalizedOrigin = origin.trim();

  if (normalizedOrigin.length === 0) {
    return false;
  }

  if (policy.siteDenylist.some((pattern) => matchesOriginPattern(normalizedOrigin, pattern))) {
    return false;
  }

  if (policy.siteAllowlist.length === 0) {
    return true;
  }

  return policy.siteAllowlist.some((pattern) => matchesOriginPattern(normalizedOrigin, pattern));
}

export function applyEnterprisePolicyToRecorderConfig(
  config: RecorderConfig,
  policy: EnterpriseRecorderPolicy
): RecorderConfig {
  const basePolicy = config.capturePolicy ?? DEFAULT_RECORDER_CONFIG.capturePolicy;
  const capturePolicy: CapturePolicy | undefined = basePolicy
    ? {
        ...basePolicy,
        mode: policy.disableLabMode && basePolicy.mode === "lab" ? "private" : basePolicy.mode,
        scope: {
          ...basePolicy.scope,
          allowedOrigins:
            policy.siteAllowlist.length > 0
              ? [...policy.siteAllowlist]
              : [...basePolicy.scope.allowedOrigins],
          deniedOrigins: [...new Set([...basePolicy.scope.deniedOrigins, ...policy.siteDenylist])]
        },
        categories: applyDataCategoryCaps(basePolicy.categories, {
          ...policy.dataCategoryCaps,
          ...(policy.disableLabMode
            ? {
                cdp: "off" as const,
                heapProfiles: "off" as const
              }
            : {})
        }),
        retention: applyRetentionCaps(basePolicy.retention, policy.retention)
      }
    : undefined;

  return {
    ...config,
    capturePolicy
  };
}

function normalizeStoredVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.floor(value);
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const output: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const trimmed = entry.trim();

    if (!trimmed || output.includes(trimmed)) {
      continue;
    }

    output.push(trimmed);
  }

  return output;
}

function normalizeDataCategoryCaps(value: unknown): EnterpriseRecorderPolicy["dataCategoryCaps"] {
  const record = asRecord(value);

  if (!record) {
    return {};
  }

  const output: EnterpriseRecorderPolicy["dataCategoryCaps"] = {};

  setEnumCap(output, "actions", record.actions, ["metadata", "masked", "allow"]);
  setEnumCap(output, "inputs", record.inputs, ["none", "length-only", "masked", "allow"]);
  setEnumCap(output, "dom", record.dom, ["off", "wireframe", "masked", "allow"]);
  setEnumCap(output, "screenshots", record.screenshots, ["off", "masked", "allow"]);
  setEnumCap(output, "console", record.console, ["off", "metadata", "sanitized", "allow"]);
  setEnumCap(output, "network", record.network, [
    "metadata",
    "headers-allowlist",
    "body-allowlist"
  ]);
  setEnumCap(output, "storage", record.storage, [
    "off",
    "counts-only",
    "names-only",
    "lengths-only",
    "allow"
  ]);
  setEnumCap(output, "indexedDb", record.indexedDb, ["off", "counts-only", "names-only"]);
  setEnumCap(output, "cookies", record.cookies, ["off", "count-only", "names-only"]);
  setEnumCap(output, "cdp", record.cdp, ["off", "safe-subset", "full"]);
  setEnumCap(output, "heapProfiles", record.heapProfiles, ["off", "lab-only"]);

  return output;
}

function setEnumCap<TKey extends keyof CapturePolicy["categories"]>(
  output: Partial<CapturePolicy["categories"]>,
  key: TKey,
  value: unknown,
  allowed: Array<CapturePolicy["categories"][TKey]>
): void {
  if (typeof value !== "string") {
    return;
  }

  if (allowed.includes(value as CapturePolicy["categories"][TKey])) {
    output[key] = value as CapturePolicy["categories"][TKey];
  }
}

function normalizeRetentionPolicy(value: unknown): EnterpriseRecorderPolicy["retention"] {
  const record = asRecord(value);

  if (!record) {
    return {};
  }

  return {
    localTtlMs: normalizePositiveInteger(record.localTtlMs),
    shareTtlMs: normalizePositiveInteger(record.shareTtlMs)
  };
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.floor(value);
}

function applyDataCategoryCaps(
  categories: CapturePolicy["categories"],
  caps: EnterpriseRecorderPolicy["dataCategoryCaps"]
): CapturePolicy["categories"] {
  return {
    actions: capEnum(categories.actions, caps.actions, ["metadata", "masked", "allow"]),
    inputs: capEnum(categories.inputs, caps.inputs, ["none", "length-only", "masked", "allow"]),
    dom: capEnum(categories.dom, caps.dom, ["off", "wireframe", "masked", "allow"]),
    screenshots: capEnum(categories.screenshots, caps.screenshots, ["off", "masked", "allow"]),
    console: capEnum(categories.console, caps.console, ["off", "metadata", "sanitized", "allow"]),
    network: capEnum(categories.network, caps.network, [
      "metadata",
      "headers-allowlist",
      "body-allowlist"
    ]),
    storage: capStorageCategory(categories.storage, caps.storage),
    indexedDb: capEnum(categories.indexedDb, caps.indexedDb, ["off", "counts-only", "names-only"]),
    cookies: capEnum(categories.cookies, caps.cookies, ["off", "count-only", "names-only"]),
    cdp: capEnum(categories.cdp, caps.cdp, ["off", "safe-subset", "full"]),
    heapProfiles: capEnum(categories.heapProfiles, caps.heapProfiles, ["off", "lab-only"])
  };
}

function capEnum<TValue extends string>(
  current: TValue,
  cap: TValue | undefined,
  orderedValues: readonly TValue[]
): TValue {
  if (!cap) {
    return current;
  }

  const currentIndex = orderedValues.indexOf(current);
  const capIndex = orderedValues.indexOf(cap);

  if (currentIndex < 0 || capIndex < 0) {
    return current;
  }

  return capIndex < currentIndex ? cap : current;
}

function capStorageCategory(
  current: CapturePolicy["categories"]["storage"],
  cap: CapturePolicy["categories"]["storage"] | undefined
): CapturePolicy["categories"]["storage"] {
  if (!cap || cap === "allow") {
    return current;
  }

  if (current === "allow") {
    return cap;
  }

  if (current === "off" || cap === "off") {
    return "off";
  }

  if (current === "counts-only" || cap === "counts-only") {
    return "counts-only";
  }

  if (current === cap) {
    return current;
  }

  return "counts-only";
}

function applyRetentionCaps(
  retention: CapturePolicy["retention"],
  caps: EnterpriseRecorderPolicy["retention"]
): CapturePolicy["retention"] {
  return {
    localTtlMs: capPositiveInteger(retention.localTtlMs, caps.localTtlMs) ?? retention.localTtlMs,
    shareTtlMs: capPositiveInteger(retention.shareTtlMs, caps.shareTtlMs)
  };
}

function capPositiveInteger(
  current: number | undefined,
  cap: number | undefined
): number | undefined {
  if (typeof cap !== "number") {
    return current;
  }

  if (typeof current !== "number") {
    return cap;
  }

  return Math.min(current, cap);
}

function matchesOriginPattern(origin: string, pattern: string): boolean {
  if (origin === pattern) {
    return true;
  }

  if (!pattern.startsWith("*.")) {
    return false;
  }

  try {
    const originHost = new URL(origin).hostname;
    const suffix = pattern.slice(2);
    return originHost === suffix || originHost.endsWith(`.${suffix}`);
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}
