import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  applyEnterprisePolicyToRecorderConfig,
  isEnterpriseOriginAllowed,
  migrateStoredRecorderConfig,
  normalizeEnterprisePolicy,
  OPTIONS_STORAGE_VERSION
} from "./options-storage.js";

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

describe("enterprise recorder policy", () => {
  it("normalizes managed site policy and category caps", () => {
    const policy = normalizeEnterprisePolicy({
      siteAllowlist: ["https://app.example", "*.trusted.example", ""],
      siteDenylist: ["https://admin.example"],
      dataCategoryCaps: {
        screenshots: "off",
        network: "metadata",
        cdp: "full",
        unknown: "allow"
      },
      disableLabMode: true,
      retention: {
        localTtlMs: 3600000,
        shareTtlMs: 7200000
      }
    });

    expect(isEnterpriseOriginAllowed("https://app.example", policy)).toBe(true);
    expect(isEnterpriseOriginAllowed("https://team.trusted.example", policy)).toBe(true);
    expect(isEnterpriseOriginAllowed("https://admin.example", policy)).toBe(false);
    expect(isEnterpriseOriginAllowed("https://other.example", policy)).toBe(false);
    expect(policy.dataCategoryCaps).toMatchObject({
      screenshots: "off",
      network: "metadata",
      cdp: "full"
    });
    expect(policy.retention.localTtlMs).toBe(3600000);
  });

  it("applies managed caps and disables lab-only capture", () => {
    const config = applyEnterprisePolicyToRecorderConfig(
      {
        ...DEFAULT_RECORDER_CONFIG,
        capturePolicy: {
          ...DEFAULT_RECORDER_CONFIG.capturePolicy!,
          mode: "lab",
          categories: {
            ...DEFAULT_RECORDER_CONFIG.capturePolicy!.categories,
            screenshots: "allow",
            network: "body-allowlist",
            cdp: "full",
            heapProfiles: "lab-only"
          }
        }
      },
      normalizeEnterprisePolicy({
        siteAllowlist: ["https://app.example"],
        siteDenylist: ["https://blocked.example"],
        dataCategoryCaps: {
          screenshots: "off",
          network: "metadata"
        },
        disableLabMode: true,
        retention: {
          localTtlMs: 60000
        }
      })
    );

    expect(config.capturePolicy?.mode).toBe("private");
    expect(config.capturePolicy?.scope.allowedOrigins).toEqual(["https://app.example"]);
    expect(config.capturePolicy?.scope.deniedOrigins).toContain("https://blocked.example");
    expect(config.capturePolicy?.categories.screenshots).toBe("off");
    expect(config.capturePolicy?.categories.network).toBe("metadata");
    expect(config.capturePolicy?.categories.cdp).toBe("off");
    expect(config.capturePolicy?.categories.heapProfiles).toBe("off");
    expect(config.capturePolicy?.retention.localTtlMs).toBe(60000);
  });

  it("does not broaden safer defaults when managed caps are more permissive", () => {
    const config = applyEnterprisePolicyToRecorderConfig(
      DEFAULT_RECORDER_CONFIG,
      normalizeEnterprisePolicy({
        dataCategoryCaps: {
          screenshots: "allow",
          network: "body-allowlist",
          storage: "allow",
          cdp: "full",
          heapProfiles: "lab-only"
        },
        retention: {
          localTtlMs: DEFAULT_RECORDER_CONFIG.capturePolicy!.retention.localTtlMs * 2
        }
      })
    );

    expect(config.capturePolicy?.categories.screenshots).toBe(
      DEFAULT_RECORDER_CONFIG.capturePolicy?.categories.screenshots
    );
    expect(config.capturePolicy?.categories.network).toBe(
      DEFAULT_RECORDER_CONFIG.capturePolicy?.categories.network
    );
    expect(config.capturePolicy?.categories.storage).toBe(
      DEFAULT_RECORDER_CONFIG.capturePolicy?.categories.storage
    );
    expect(config.capturePolicy?.categories.cdp).toBe(
      DEFAULT_RECORDER_CONFIG.capturePolicy?.categories.cdp
    );
    expect(config.capturePolicy?.categories.heapProfiles).toBe(
      DEFAULT_RECORDER_CONFIG.capturePolicy?.categories.heapProfiles
    );
    expect(config.capturePolicy?.retention.localTtlMs).toBe(
      DEFAULT_RECORDER_CONFIG.capturePolicy?.retention.localTtlMs
    );
  });
});
