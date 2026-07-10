import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { parseExtensionBuildArgs } from "../../scripts/lib/extension-build-cli.mjs";
import {
  assertChromeArchive,
  createChromeArchive,
  createExtensionManifest,
  validateExtensionManifest
} from "../../scripts/lib/extension-build.mjs";

describe("extension build CLI", () => {
  it("defaults package builds to release store-safe artifacts", () => {
    expect(parseExtensionBuildArgs(["--package"])).toMatchObject({
      release: true,
      packageArchive: true,
      profile: "store-safe"
    });
  });

  it("requires an explicit dev profile for enterprise packages", () => {
    expect(parseExtensionBuildArgs(["--package", "--profile", "dev"])).toMatchObject({
      release: true,
      packageArchive: true,
      profile: "dev"
    });
  });

  it("keeps ordinary unpacked builds in development mode", () => {
    expect(parseExtensionBuildArgs([])).toMatchObject({
      release: false,
      packageArchive: false,
      profile: "dev"
    });
  });
});

describe("extension build manifest", () => {
  it("creates a development manifest with explicit CSP", () => {
    const manifest = createExtensionManifest({ version: "1.2.3" });

    expect(manifest.version).toBe("1.2.3");
    expect(manifest.default_locale).toBe("en");
    expect(manifest.name).toBe("__MSG_extensionName__");
    expect(manifest.key).toBeTypeOf("string");
    expect(manifest.permissions).not.toContain("activeTab");
    expect(manifest.permissions).not.toContain("cookies");
    expect(manifest.permissions).toContain("alarms");
    expect(manifest.permissions).toContain("tabCapture");
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(manifest.content_security_policy?.extension_pages).toContain("script-src 'self'");
    expect(manifest.content_security_policy?.extension_pages).not.toContain("'unsafe-inline'");
    expect(validateExtensionManifest(manifest, { version: "1.2.3" })).toEqual([]);
  });

  it("creates a store-safe manifest without broad capture permissions", () => {
    const manifest = createExtensionManifest({
      version: "1.2.3",
      release: true,
      profile: "store-safe"
    });

    expect(manifest).not.toHaveProperty("key");
    expect(manifest.permissions).toContain("activeTab");
    expect(manifest.permissions).toContain("alarms");
    expect(manifest.permissions).toContain("tabCapture");
    expect(manifest.permissions).not.toContain("debugger");
    expect(manifest.permissions).not.toContain("tabs");
    expect(manifest.permissions).not.toContain("webRequest");
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(
      validateExtensionManifest(manifest, {
        version: "1.2.3",
        release: true,
        profile: "store-safe"
      })
    ).toEqual([]);
  });

  it("creates a release manifest without the development key", () => {
    const manifest = createExtensionManifest({ version: "1.2.3", release: true });

    expect(manifest).not.toHaveProperty("key");
    expect(validateExtensionManifest(manifest, { version: "1.2.3", release: true })).toEqual([]);
  });

  it.each(["1", "0.0.0.1", "65535.65535.65535.65535"])(
    "accepts Chrome extension version boundary %s",
    (version) => {
      const manifest = createExtensionManifest({ version, release: true });
      expect(validateExtensionManifest(manifest, { version, release: true })).toEqual([]);
    }
  );

  it.each([
    "0",
    "0.0.0.0",
    "01.2.3",
    "1..2",
    "1.2.65536",
    "1.2.3.4.5",
    "1.2.3-beta.1",
    "1.2.3+build.7"
  ])("rejects Chrome-incompatible extension version %s", (version) => {
    const manifest = createExtensionManifest({ version, release: true });
    expect(validateExtensionManifest(manifest, { version, release: true })).toContain(
      "Manifest version must use 1-4 dot-separated integers from 0 to 65535, without leading zeroes, and must not be all zero."
    );
  });

  it("rejects store-safe packages without restart-safe cleanup alarms", () => {
    const manifest = createExtensionManifest({
      version: "1.2.3",
      release: true,
      profile: "store-safe"
    });
    manifest.permissions = manifest.permissions.filter((permission) => permission !== "alarms");

    expect(
      validateExtensionManifest(manifest, {
        version: "1.2.3",
        release: true,
        profile: "store-safe"
      })
    ).toContain("Store-safe manifest must include 'alarms' permission.");
  });

  it("rejects always-on content scripts in the development profile", () => {
    const manifest = createExtensionManifest({ version: "1.2.3", profile: "dev" });
    manifest.content_scripts = [
      {
        matches: ["<all_urls>"],
        js: ["content.js"],
        all_frames: true
      }
    ];

    expect(validateExtensionManifest(manifest, { version: "1.2.3", profile: "dev" })).toContain(
      "Dev manifest must use policy-scoped dynamic content-script injection."
    );
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

  it("packages store-safe archives without reintroducing broad permissions", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "webblackbox-extension-store-test-"));
    const sourceDir = resolve(root, "build");
    const archivePath = resolve(root, "archive.zip");

    try {
      await writeBuildFixture(
        sourceDir,
        createExtensionManifest({
          version: "1.2.3",
          profile: "store-safe"
        })
      );

      const archive = await createChromeArchive({
        sourceDir,
        outputPath: archivePath
      });

      const zip = await JSZip.loadAsync(await readFile(archive.path));
      const packagedManifest = JSON.parse(await zip.file("manifest.json").async("text"));

      expect(packagedManifest).not.toHaveProperty("key");
      expect(packagedManifest.permissions).toContain("tabCapture");
      expect(packagedManifest.permissions).not.toContain("debugger");
      expect(packagedManifest.permissions).not.toContain("tabs");
      expect(packagedManifest.permissions).not.toContain("webRequest");
      expect(packagedManifest).not.toHaveProperty("host_permissions");
      expect(packagedManifest).not.toHaveProperty("content_scripts");
      await expect(
        assertChromeArchive(archive.path, {
          version: "1.2.3",
          profile: "store-safe"
        })
      ).resolves.toMatchObject({ version: "1.2.3" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a dev archive when a store-safe artifact is required", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "webblackbox-extension-unsafe-store-test-"));
    const sourceDir = resolve(root, "build");
    const archivePath = resolve(root, "archive.zip");

    try {
      await writeBuildFixture(
        sourceDir,
        createExtensionManifest({
          version: "1.2.3",
          profile: "dev"
        })
      );

      const archive = await createChromeArchive({
        sourceDir,
        outputPath: archivePath
      });

      await expect(
        assertChromeArchive(archive.path, {
          version: "1.2.3",
          profile: "store-safe"
        })
      ).rejects.toThrow("Store-safe manifest must not request the debugger permission");
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
    "content-agent.js": "export {};\n",
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
