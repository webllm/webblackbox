import { describe, expect, it } from "vitest";

import {
  createExtensionManifest,
  validateExtensionManifest
} from "../../scripts/lib/extension-build.mjs";

describe("extension build manifest", () => {
  it("creates a development manifest with explicit CSP", () => {
    const manifest = createExtensionManifest({ version: "1.2.3" });

    expect(manifest.version).toBe("1.2.3");
    expect(manifest.key).toBeTypeOf("string");
    expect(manifest.content_security_policy?.extension_pages).toContain("script-src 'self'");
    expect(validateExtensionManifest(manifest, { version: "1.2.3" })).toEqual([]);
  });

  it("creates a release manifest without the development key", () => {
    const manifest = createExtensionManifest({ version: "1.2.3", release: true });

    expect(manifest).not.toHaveProperty("key");
    expect(validateExtensionManifest(manifest, { version: "1.2.3", release: true })).toEqual([]);
  });

  it("fails validation when explicit CSP is removed", () => {
    const manifest = createExtensionManifest({ version: "1.2.3", release: true });

    delete manifest.content_security_policy;

    expect(validateExtensionManifest(manifest, { version: "1.2.3", release: true })).toContain(
      "Manifest must declare an explicit content_security_policy.extension_pages."
    );
  });
});
