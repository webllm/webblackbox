import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { migrateStoredRecorderConfig, OPTIONS_STORAGE_VERSION } from "./options-storage.js";

describe("options-storage", () => {
  it("migrates legacy lite screenshot defaults back to the new runtime default", () => {
    const migrated = migrateStoredRecorderConfig({
      sampling: {
        screenshotIdleMs: 0,
        bodyCaptureMaxBytes: 0
      }
    });

    expect(migrated.optionsVersion).toBe(OPTIONS_STORAGE_VERSION);
    expect(migrated.sampling).toMatchObject({
      screenshotIdleMs: DEFAULT_RECORDER_CONFIG.sampling.screenshotIdleMs,
      bodyCaptureMaxBytes: 0
    });
  });

  it("preserves explicit post-migration values", () => {
    const migrated = migrateStoredRecorderConfig({
      optionsVersion: OPTIONS_STORAGE_VERSION,
      sampling: {
        screenshotIdleMs: 0
      }
    });

    expect(migrated.sampling).toMatchObject({
      screenshotIdleMs: 0
    });
  });
});
