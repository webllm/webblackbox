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
  validateInjectedModuleBuildSource,
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
    expect(manifest.permissions).toContain("webNavigation");
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(manifest.web_accessible_resources).toEqual([
      {
        resources: ["content-agent.js", "injected.js"],
        matches: ["<all_urls>"],
        use_dynamic_url: true
      }
    ]);
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
    expect(manifest.permissions).not.toContain("tabCapture");
    expect(manifest.permissions).toContain("webNavigation");
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

  it.each(["dev", "store-safe"])(
    "accepts only the exact %s permission set regardless of order",
    (profile) => {
      const release = profile === "store-safe";
      const manifest = createExtensionManifest({ version: "1.2.3", release, profile });
      manifest.permissions.reverse();
      manifest.optional_permissions = [];
      manifest.optional_host_permissions = [];

      if (profile === "store-safe") {
        manifest.host_permissions = [];
      }

      expect(
        validateExtensionManifest(manifest, {
          version: "1.2.3",
          release,
          profile
        })
      ).toEqual([]);
    }
  );

  it.each([
    ["dev", "history"],
    ["dev", "cookies"],
    ["dev", "management"],
    ["store-safe", "history"],
    ["store-safe", "cookies"],
    ["store-safe", "management"],
    ["store-safe", "tabCapture"]
  ])("rejects undeclared %s permission %s", (profile, permission) => {
    const release = profile === "store-safe";
    const manifest = createExtensionManifest({ version: "1.2.3", release, profile });
    manifest.permissions.push(permission);

    const label = profile === "store-safe" ? "Store-safe" : "Dev";
    expect(
      validateExtensionManifest(manifest, {
        version: "1.2.3",
        release,
        profile
      })
    ).toContain(`${label} manifest must not request undeclared permission '${permission}'.`);
  });

  it.each(["dev", "store-safe"])("rejects duplicate permissions in the %s profile", (profile) => {
    const release = profile === "store-safe";
    const manifest = createExtensionManifest({ version: "1.2.3", release, profile });
    const duplicate = manifest.permissions[0];
    manifest.permissions.push(duplicate);

    expect(
      validateExtensionManifest(manifest, {
        version: "1.2.3",
        release,
        profile
      })
    ).toContain(`permissions must not contain duplicate value '${duplicate}'.`);
  });

  it.each([
    ["dev", "downloads"],
    ["store-safe", "scripting"]
  ])("rejects a missing required %s permission", (profile, permission) => {
    const release = profile === "store-safe";
    const manifest = createExtensionManifest({ version: "1.2.3", release, profile });
    manifest.permissions = manifest.permissions.filter((entry) => entry !== permission);

    const label = profile === "store-safe" ? "Store-safe" : "Dev";
    expect(
      validateExtensionManifest(manifest, {
        version: "1.2.3",
        release,
        profile
      })
    ).toContain(`${label} manifest must include '${permission}' permission.`);
  });

  it("rejects missing, duplicate, and undeclared dev host permissions", () => {
    const base = createExtensionManifest({ version: "1.2.3", profile: "dev" });

    const missing = { ...base, host_permissions: [] };
    expect(validateExtensionManifest(missing, { version: "1.2.3", profile: "dev" })).toContain(
      "Dev manifest must include <all_urls> host permission."
    );

    const duplicate = { ...base, host_permissions: ["<all_urls>", "<all_urls>"] };
    expect(validateExtensionManifest(duplicate, { version: "1.2.3", profile: "dev" })).toContain(
      "host_permissions must not contain duplicate value '<all_urls>'."
    );

    const undeclared = {
      ...base,
      host_permissions: ["<all_urls>", "https://example.com/*"]
    };
    expect(validateExtensionManifest(undeclared, { version: "1.2.3", profile: "dev" })).toContain(
      "Dev manifest must not request undeclared host permission 'https://example.com/*'."
    );
  });

  it("rejects any persistent host permissions in the store-safe profile", () => {
    const manifest = createExtensionManifest({
      version: "1.2.3",
      release: true,
      profile: "store-safe"
    });
    manifest.host_permissions = ["https://example.com/*"];

    expect(
      validateExtensionManifest(manifest, {
        version: "1.2.3",
        release: true,
        profile: "store-safe"
      })
    ).toContain("Store-safe manifest must not declare persistent host_permissions.");
  });

  it.each(["optional_permissions", "optional_host_permissions"])(
    "rejects a non-empty %s allowlist",
    (fieldName) => {
      const manifest = createExtensionManifest({ version: "1.2.3", profile: "dev" });
      manifest[fieldName] = [fieldName === "optional_permissions" ? "history" : "<all_urls>"];

      expect(validateExtensionManifest(manifest, { version: "1.2.3", profile: "dev" })).toContain(
        `Manifest ${fieldName} must be absent or an empty array.`
      );
    }
  );

  it.each(["optional_permissions", "optional_host_permissions"])(
    "rejects a non-array %s value",
    (fieldName) => {
      const manifest = createExtensionManifest({ version: "1.2.3", profile: "dev" });
      manifest[fieldName] = null;

      expect(validateExtensionManifest(manifest, { version: "1.2.3", profile: "dev" })).toContain(
        `Manifest ${fieldName} must be absent or an empty array.`
      );
    }
  );

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

  it.each(["dev", "store-safe"])(
    "requires webNavigation permission in the %s profile",
    (profile) => {
      const release = profile === "store-safe";
      const manifest = createExtensionManifest({ version: "1.2.3", release, profile });
      manifest.permissions = manifest.permissions.filter(
        (permission) => permission !== "webNavigation"
      );

      const label = profile === "store-safe" ? "Store-safe" : "Dev";
      expect(
        validateExtensionManifest(manifest, {
          version: "1.2.3",
          release,
          profile
        })
      ).toContain(`${label} manifest must include 'webNavigation' permission.`);
    }
  );

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

  it.each([undefined, false])(
    "rejects web resources when use_dynamic_url is %s",
    (useDynamicUrl) => {
      const manifest = createExtensionManifest({ version: "1.2.3", release: true });
      const [resourceEntry] = manifest.web_accessible_resources;

      if (useDynamicUrl === undefined) {
        delete resourceEntry.use_dynamic_url;
      } else {
        resourceEntry.use_dynamic_url = useDynamicUrl;
      }

      expect(validateExtensionManifest(manifest, { version: "1.2.3", release: true })).toContain(
        "Manifest web resources must use dynamic URLs."
      );
    }
  );

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

  it("creates byte-for-byte reproducible archives without generated directory entries", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "webblackbox-extension-repro-test-"));
    const sourceDir = resolve(root, "build");
    const firstArchivePath = resolve(root, "first.zip");
    const secondArchivePath = resolve(root, "second.zip");

    try {
      await writeBuildFixture(sourceDir, createExtensionManifest({ version: "1.2.3" }));
      await createChromeArchive({ sourceDir, outputPath: firstArchivePath });
      await createChromeArchive({ sourceDir, outputPath: secondArchivePath });

      const firstBytes = await readFile(firstArchivePath);
      const secondBytes = await readFile(secondArchivePath);
      expect(firstBytes.equals(secondBytes)).toBe(true);

      const zip = await JSZip.loadAsync(firstBytes);
      const entries = Object.values(zip.files);
      expect(entries.some((entry) => entry.dir)).toBe(false);
      expect(entries.every((entry) => entry.date.getTime() === Date.UTC(1980, 0, 1))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when stale files remain in the build directory", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "webblackbox-extension-closed-build-test-"));
    const sourceDir = resolve(root, "build");

    try {
      await writeBuildFixture(sourceDir, createExtensionManifest({ version: "1.2.3" }));
      await writeFile(resolve(sourceDir, "unexpected-debug.txt"), "must not ship\n", "utf8");

      await expect(
        createChromeArchive({ sourceDir, outputPath: resolve(root, "archive.zip") })
      ).rejects.toThrow("Unexpected packaged file 'unexpected-debug.txt'");
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
      expect(packagedManifest.permissions).not.toContain("tabCapture");
      expect(packagedManifest.permissions).toContain("webNavigation");
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

describe("injected module build output", () => {
  it("accepts only the direct bootstrap and control ESM exports", () => {
    expect(
      validateInjectedModuleBuildSource(`
        function directBootstrap() {}
        function directControl() {}
        export {
          directBootstrap as bootstrap,
          directControl as control
        };
      `)
    ).toEqual([]);
  });

  it.each([
    ["no exports", "function bootstrap() {}\nfunction control() {}\n"],
    [
      "an extra export",
      "export function bootstrap() {}\nexport function control() {}\nexport const autoInstall = true;\n"
    ],
    [
      "a default export",
      "export function bootstrap() {}\nexport function control() {}\nexport default bootstrap;\n"
    ],
    [
      "export text inside a string",
      "const source = 'export function bootstrap() {} export function control() {}';\n"
    ],
    [
      "a star re-export",
      "export function bootstrap() {}\nexport function control() {}\nexport * from './extra.js';\n"
    ]
  ])("rejects %s", (_case, source) => {
    expect(validateInjectedModuleBuildSource(source)).not.toEqual([]);
  });
});

async function writeBuildFixture(outputDir, manifest) {
  const fixtureFiles = {
    "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "_locales/en/messages.json": '{"extensionName":{"message":"WebBlackbox"}}\n',
    "_locales/zh_CN/messages.json": '{"extensionName":{"message":"WebBlackbox"}}\n',
    "content-agent.js": "export {};\n",
    "content.js": "export {};\n",
    "injected.js": "export function bootstrap() {}\nexport function control() {}\n",
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
