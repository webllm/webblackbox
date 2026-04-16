import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  createChromeArchive,
  createExtensionManifest,
  validateExtensionManifest
} from "../../scripts/lib/extension-build.mjs";

describe("extension build manifest", () => {
  it("creates a development manifest with explicit CSP", () => {
    const manifest = createExtensionManifest({ version: "1.2.3" });

    expect(manifest.version).toBe("1.2.3");
    expect(manifest.default_locale).toBe("en");
    expect(manifest.name).toBe("__MSG_extensionName__");
    expect(manifest.key).toBeTypeOf("string");
    expect(manifest.permissions).not.toContain("activeTab");
    expect(manifest.permissions).not.toContain("cookies");
    expect(manifest.content_security_policy?.extension_pages).toContain("script-src 'self'");
    expect(manifest.content_security_policy?.extension_pages).not.toContain("'unsafe-inline'");
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

  it("fails validation when inline styles are re-enabled in the CSP", () => {
    const manifest = createExtensionManifest({ version: "1.2.3", release: true });
    manifest.content_security_policy.extension_pages =
      "script-src 'self'; object-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;";

    expect(validateExtensionManifest(manifest, { version: "1.2.3", release: true })).toContain(
      "Manifest content_security_policy.extension_pages must not include 'unsafe-inline'."
    );
  });

  it("packages a release archive without the development key", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "webblackbox-extension-build-test-"));
    const sourceDir = resolve(root, "build");
    const archivePath = resolve(root, "archive.zip");

    try {
      await writeBuildFixture(sourceDir, createExtensionManifest({ version: "1.2.3" }));

      const archive = await createChromeArchive({
        sourceDir,
        outputPath: archivePath
      });

      const zip = await JSZip.loadAsync(await readFile(archive.path));
      const packagedManifest = JSON.parse(await zip.file("manifest.json").async("text"));

      expect(archive.manifest.version).toBe("1.2.3");
      expect(archive.strippedKeys).toEqual(["key"]);
      expect(packagedManifest.version).toBe("1.2.3");
      expect(packagedManifest).not.toHaveProperty("key");
      expect(zip.file("popup.js")).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeBuildFixture(outputDir, manifest) {
  const fixtureFiles = {
    "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "_locales/en/messages.json": '{"extensionName":{"message":"WebBlackbox"}}\n',
    "_locales/zh_CN/messages.json": '{"extensionName":{"message":"WebBlackbox"}}\n',
    "content.js": "export {};\n",
    "injected.js": "export {};\n",
    "offscreen.html": "<!doctype html><title>offscreen</title>\n",
    "offscreen.js": "export {};\n",
    "options.html": "<!doctype html><title>options</title>\n",
    "options.js": "export {};\n",
    "popup.html": "<!doctype html><title>popup</title>\n",
    "popup.js": "export {};\n",
    "sessions.html": "<!doctype html><title>sessions</title>\n",
    "sessions.js": "export {};\n",
    "styles.css": "body{margin:0;}\n",
    "sw.js": "export {};\n",
    "icon/16.png": "icon",
    "icon/32.png": "icon",
    "icon/48.png": "icon",
    "icon/96.png": "icon",
    "icon/128.png": "icon"
  };

  await Promise.all(
    Object.entries(fixtureFiles).map(async ([relativePath, content]) => {
      const absolutePath = resolve(outputDir, relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content);
    })
  );
}
