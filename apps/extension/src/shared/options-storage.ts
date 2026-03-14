import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";

export const OPTIONS_STORAGE_VERSION = 1;

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

function normalizeStoredVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.floor(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}
