import { type CaptureMode, type RecorderConfig } from "@webblackbox/protocol";

import { applyModeProductBoundary } from "./mode-profile.js";
import { migrateStoredRecorderConfig } from "./options-storage.js";

export function resolveModeRecorderConfig(
  mode: CaptureMode,
  baseConfig: RecorderConfig,
  storedValue: unknown
): RecorderConfig {
  const stored = asRecord(storedValue);

  if (!stored) {
    return applyModeProductBoundary(mode, baseConfig);
  }

  const migrated = migrateStoredRecorderConfig(stored);

  const mergedConfig: RecorderConfig = {
    ...baseConfig,
    ...migrated,
    mode,
    sampling: {
      ...baseConfig.sampling,
      ...(asRecord(migrated.sampling) ?? {})
    },
    redaction: {
      ...baseConfig.redaction,
      ...(asRecord(migrated.redaction) ?? {})
    },
    sitePolicies: Array.isArray(migrated.sitePolicies)
      ? (migrated.sitePolicies as RecorderConfig["sitePolicies"])
      : baseConfig.sitePolicies
  };

  return applyModeProductBoundary(mode, mergedConfig);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
