import { constants } from "node:fs";
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { init as initEsmLexer, parse as parseEsm } from "es-module-lexer";

await initEsmLexer;

const scriptDir = dirname(fileURLToPath(import.meta.url));

export const appRoot = resolve(scriptDir, "..", "..");
export const buildDir = resolve(appRoot, "build");
export const distDir = resolve(appRoot, "dist");
export const publicDir = resolve(appRoot, "public");
export const packageJsonPath = resolve(appRoot, "package.json");

const EXTENSION_DEFAULT_LOCALE = "en";
const EXTENSION_NAME = "__MSG_extensionName__";
const EXTENSION_DESCRIPTION = "__MSG_extensionDescription__";
const EXTENSION_ARCHIVE_NAME = "WebBlackbox";
const EXTENSION_ARCHIVE_SLUG = "webblackbox";
const EXTENSION_MINIMUM_CHROME_VERSION = "125";
const EXTENSION_DEVELOPMENT_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2HDVz1RBsIjEKY/KUOuP3glU4SmMUtvdXXER0JV9mksg6cufsMXUwPpzj7M4aCqCPMV8NkMhRHuGEumnDx/lhc/UI1OUyGpMSP2DSozID5w1s6NY2NbBERcNe0QPwlG9DBkZHHrSXycAHBK8IOaGcsju3Dzmbxr9RI7boLVE0dchdo5bt9tyOxT6LQL1ZlQOgErRf2pSQpU/dqngQ0Wd3/rj5aZ9c04TkycJrXq1FBY4uBiUdFOjuQ6djW4UtJsudYuDaqZ5PsRErilDAbWttkQsN7w5lS7aJANEU/83nIyz8YZ56vn1P1wBqWOxJ2CsyW/lFJdKjgZor6AS5AWCRQIDAQAB";
const EXTENSION_PAGE_CSP =
  "script-src 'self'; object-src 'self'; style-src 'self'; img-src 'self' data:;";
const STATIC_PUBLIC_FILES = [
  "_locales",
  "offscreen.html",
  "options.html",
  "popup.html",
  "sessions.html",
  "styles.css",
  "icon"
];
const REQUIRED_BUILD_FILES = [
  "manifest.json",
  "_locales/en/messages.json",
  "_locales/zh_CN/messages.json",
  "content.js",
  "content-agent.js",
  "injected.js",
  "offscreen.html",
  "offscreen.js",
  "options.html",
  "options.js",
  "popup.html",
  "popup.js",
  "sessions.html",
  "sessions.js",
  "styles.css",
  "sw.js",
  "icon/16.png",
  "icon/32.png",
  "icon/48.png",
  "icon/96.png",
  "icon/128.png"
];

export const EXTENSION_MANIFEST_PROFILES = ["dev", "store-safe"];

// Cookie snapshots are collected through the CDP Storage domain via `debugger`,
// and persistent host access comes from `<all_urls>`, so neither `cookies`
// nor `activeTab` belongs in the dev/enterprise permission set.
const DEV_PERMISSIONS = [
  "alarms",
  "debugger",
  "downloads",
  "offscreen",
  "scripting",
  "storage",
  "tabCapture",
  "tabs",
  "webNavigation",
  "webRequest"
];
const STORE_SAFE_PERMISSIONS = [
  "activeTab",
  "alarms",
  "downloads",
  "offscreen",
  "scripting",
  "storage",
  "webNavigation"
];
const URL_MATCHES = ["<all_urls>"];
const ARCHIVE_FIXED_DATE = new Date("1980-01-01T00:00:00.000Z");
const ARCHIVE_EXCLUDED_FILE_NAMES = new Set([".DS_Store"]);
const INJECTED_MODULE_EXPORTS = ["bootstrap", "control"];

async function readJson(path) {
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readAppPackage() {
  return readJson(packageJsonPath);
}

export function createExtensionManifest({ version, release = false, profile = "dev" }) {
  const normalizedProfile = normalizeManifestProfile(profile);
  const storeSafe = normalizedProfile === "store-safe";
  const manifest = {
    manifest_version: 3,
    default_locale: EXTENSION_DEFAULT_LOCALE,
    name: EXTENSION_NAME,
    description: EXTENSION_DESCRIPTION,
    version,
    ...(release ? {} : { key: EXTENSION_DEVELOPMENT_KEY }),
    minimum_chrome_version: EXTENSION_MINIMUM_CHROME_VERSION,
    permissions: storeSafe ? [...STORE_SAFE_PERMISSIONS] : [...DEV_PERMISSIONS],
    ...(storeSafe ? {} : { host_permissions: [...URL_MATCHES] }),
    background: {
      service_worker: "sw.js",
      type: "module"
    },
    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      96: "icon/96.png",
      128: "icon/128.png"
    },
    action: {
      default_title: "__MSG_extensionActionTitle__",
      default_popup: "popup.html",
      default_icon: {
        16: "icon/16.png",
        32: "icon/32.png",
        48: "icon/48.png"
      }
    },
    options_page: "options.html",
    web_accessible_resources: [
      {
        resources: ["content-agent.js", "injected.js"],
        matches: [...URL_MATCHES],
        use_dynamic_url: true
      }
    ],
    content_security_policy: {
      extension_pages: EXTENSION_PAGE_CSP
    },
    commands: {
      "mark-bug": {
        description: "__MSG_extensionCommandMarkBug__",
        suggested_key: {
          default: "Ctrl+Shift+M",
          mac: "Command+Shift+M"
        }
      }
    }
  };

  return manifest;
}

export function validateExtensionManifest(
  manifest,
  { version, release = false, profile = "dev" } = {}
) {
  const issues = [];
  const normalizedProfile = normalizeManifestProfile(profile);
  const storeSafe = normalizedProfile === "store-safe";

  if (manifest?.manifest_version !== 3) {
    issues.push("manifest_version must be 3.");
  }

  if (manifest?.default_locale !== EXTENSION_DEFAULT_LOCALE) {
    issues.push(`default_locale must be ${EXTENSION_DEFAULT_LOCALE}.`);
  }

  if (version && manifest?.version !== version) {
    issues.push(`Manifest version must match package version ${version}.`);
  }

  if (!isValidChromeExtensionVersion(manifest?.version)) {
    issues.push(
      "Manifest version must use 1-4 dot-separated integers from 0 to 65535, without leading zeroes, and must not be all zero."
    );
  }

  if (release && Object.hasOwn(manifest ?? {}, "key")) {
    issues.push("Release manifest must not include the extension key.");
  }

  if (!release && typeof manifest?.key !== "string") {
    issues.push("Development manifest must include the extension key.");
  }

  const extensionPagesCsp = manifest?.content_security_policy?.extension_pages;
  if (typeof extensionPagesCsp !== "string" || extensionPagesCsp.length === 0) {
    issues.push("Manifest must declare an explicit content_security_policy.extension_pages.");
  } else if (extensionPagesCsp.includes("'unsafe-inline'")) {
    issues.push(
      "Manifest content_security_policy.extension_pages must not include 'unsafe-inline'."
    );
  }

  const webAccessibleResources = manifest?.web_accessible_resources;
  const injectedResourceEntry =
    Array.isArray(webAccessibleResources) && webAccessibleResources.length === 1
      ? webAccessibleResources[0]
      : null;
  const injectedResources = injectedResourceEntry?.resources;

  if (
    !Array.isArray(injectedResources) ||
    injectedResources.join(",") !== "content-agent.js,injected.js"
  ) {
    issues.push("Manifest must only expose content-agent.js and injected.js as web resources.");
  }

  if (injectedResourceEntry?.use_dynamic_url !== true) {
    issues.push("Manifest web resources must use dynamic URLs.");
  }

  if (storeSafe) {
    validateStoreSafeManifest(manifest, issues);
  } else {
    validateDevManifest(manifest, issues);
  }

  validateAbsentOrEmptyArray(manifest, "optional_permissions", issues);
  validateAbsentOrEmptyArray(manifest, "optional_host_permissions", issues);

  return issues;
}

export function validateInjectedModuleBuildSource(source) {
  if (typeof source !== "string") {
    return ["injected.js must be an ECMAScript module source file."];
  }

  let imports;
  let exports;
  try {
    [imports, exports] = parseEsm(source, "injected.js");
  } catch (error) {
    return [
      `injected.js must contain valid ECMAScript module syntax: ${
        error instanceof Error ? error.message : String(error)
      }`
    ];
  }

  const actualExports = [...new Set(exports.map((entry) => entry.n))].sort();
  const expectedExports = [...INJECTED_MODULE_EXPORTS].sort();
  const issues = [];

  if (actualExports.join(",") !== expectedExports.join(",")) {
    issues.push(
      `injected.js must only export ${INJECTED_MODULE_EXPORTS.join(" and ")}; found ${
        actualExports.length > 0 ? actualExports.join(", ") : "no named exports"
      }.`
    );
  }

  if (actualExports.includes("default")) {
    issues.push("injected.js must not expose a default export.");
  }

  if (imports.some((entry) => source.startsWith("export", entry.ss))) {
    issues.push("injected.js must not re-export code from another module.");
  }

  return issues;
}

function isValidChromeExtensionVersion(value) {
  if (typeof value !== "string") {
    return false;
  }

  const components = value.split(".");
  if (components.length < 1 || components.length > 4) {
    return false;
  }

  let nonZero = false;
  for (const component of components) {
    if (!/^(?:0|[1-9]\d*)$/.test(component)) {
      return false;
    }
    const numeric = Number(component);
    if (!Number.isSafeInteger(numeric) || numeric > 65_535) {
      return false;
    }
    nonZero ||= numeric !== 0;
  }

  return nonZero;
}

export async function copyPublicAssets(outputDir) {
  await mkdir(outputDir, { recursive: true });

  await Promise.all(
    STATIC_PUBLIC_FILES.map((entry) =>
      cp(resolve(publicDir, entry), resolve(outputDir, entry), { recursive: true })
    )
  );
}

export async function writeGeneratedManifest(outputDir, { release = false, profile = "dev" } = {}) {
  const appPackage = await readAppPackage();
  const version =
    typeof appPackage?.version === "string" && appPackage.version.length > 0
      ? appPackage.version
      : null;

  if (!version) {
    throw new Error(`Missing version in ${packageJsonPath}`);
  }

  const manifest = createExtensionManifest({ version, release, profile });
  const issues = validateExtensionManifest(manifest, { version, release, profile });

  if (issues.length > 0) {
    throw new Error(`Generated manifest is invalid:\n- ${issues.join("\n- ")}`);
  }

  await writeJson(resolve(outputDir, "manifest.json"), manifest);
  return manifest;
}

export async function assertExtensionBuild(outputDir, { version, release = false, profile } = {}) {
  await Promise.all(
    REQUIRED_BUILD_FILES.map((file) => access(resolve(outputDir, file), constants.R_OK))
  );
  const buildFileIssues = validatePackagedFileSet(await listPackagedFiles(outputDir));
  if (buildFileIssues.length > 0) {
    throw new Error(`Build output file set is invalid:\n- ${buildFileIssues.join("\n- ")}`);
  }

  const manifest = await readJson(resolve(outputDir, "manifest.json"));
  const resolvedProfile = profile ?? inferManifestProfile(manifest);
  const issues = validateExtensionManifest(manifest, {
    version,
    release,
    profile: resolvedProfile
  });

  if (issues.length > 0) {
    throw new Error(`Build output manifest is invalid:\n- ${issues.join("\n- ")}`);
  }

  const injectedModuleIssues = validateInjectedModuleBuildSource(
    await readFile(resolve(outputDir, "injected.js"), "utf8")
  );
  if (injectedModuleIssues.length > 0) {
    throw new Error(
      `Build output injected module is invalid:\n- ${injectedModuleIssues.join("\n- ")}`
    );
  }

  return manifest;
}

export async function prepareBuildOutput({
  outputDir = buildDir,
  release = false,
  profile = "dev"
} = {}) {
  await copyPublicAssets(outputDir);
  const manifest = await writeGeneratedManifest(outputDir, { release, profile });
  await assertExtensionBuild(outputDir, { version: manifest.version, release, profile });
  return manifest;
}

export async function createChromeArchive({ sourceDir = buildDir, outputPath } = {}) {
  await stat(sourceDir);

  const sourceManifest = await readJson(resolve(sourceDir, "manifest.json"));
  const version =
    typeof sourceManifest?.version === "string" && sourceManifest.version.length > 0
      ? sourceManifest.version
      : null;
  const sourceReleaseBuild = !Object.hasOwn(sourceManifest ?? {}, "key");
  const sourceProfile = inferManifestProfile(sourceManifest);

  if (!version) {
    throw new Error(`Missing manifest version in ${resolve(sourceDir, "manifest.json")}`);
  }

  await assertExtensionBuild(sourceDir, {
    version,
    release: sourceReleaseBuild,
    profile: sourceProfile
  });

  const releaseManifest = createExtensionManifest({
    version,
    release: true,
    profile: sourceProfile
  });
  const releaseIssues = validateExtensionManifest(releaseManifest, {
    version,
    release: true,
    profile: sourceProfile
  });

  if (releaseIssues.length > 0) {
    throw new Error(`Release manifest is invalid:\n- ${releaseIssues.join("\n- ")}`);
  }

  const archiveSlug = slugify(EXTENSION_ARCHIVE_SLUG);
  const archiveVariant = sourceProfile === "store-safe" ? "chrome" : "enterprise-chrome";
  const resolvedOutputPath = outputPath
    ? resolve(process.cwd(), outputPath)
    : resolve(distDir, `${archiveSlug}-${version}-${archiveVariant}.zip`);

  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await mkdir(distDir, { recursive: true });

  if (!outputPath) {
    await removeStaleArchives(distDir, archiveSlug, archiveVariant, resolvedOutputPath);
  }

  await rm(resolvedOutputPath, { force: true });

  const zip = new JSZip();
  const files = await listPackagedFiles(sourceDir);
  const releaseManifestBytes = Buffer.from(`${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");

  for (const relativePath of files) {
    const bytes =
      relativePath === "manifest.json"
        ? releaseManifestBytes
        : await readFile(resolve(sourceDir, relativePath));

    zip.file(relativePath, bytes, {
      binary: true,
      date: ARCHIVE_FIXED_DATE,
      createFolders: false
    });
  }

  const archiveBytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: {
      level: 6
    },
    platform: "UNIX"
  });

  await writeFile(resolvedOutputPath, archiveBytes);

  await assertChromeArchive(resolvedOutputPath, {
    version,
    profile: sourceProfile
  });

  const archiveStat = await stat(resolvedOutputPath);

  return {
    path: resolvedOutputPath,
    bytes: archiveStat.size,
    manifest: {
      name: EXTENSION_ARCHIVE_NAME,
      version: releaseManifest.version,
      profile: sourceProfile
    },
    strippedKeys: Object.hasOwn(sourceManifest ?? {}, "key") ? ["key"] : []
  };
}

export async function assertChromeArchive(archivePath, { version, profile = "store-safe" } = {}) {
  const archiveBytes = await readFile(archivePath);
  const zip = await JSZip.loadAsync(archiveBytes);
  const directoryEntries = Object.values(zip.files)
    .filter((entry) => entry.dir)
    .map((entry) => entry.name)
    .sort();
  if (directoryEntries.length > 0) {
    throw new Error(
      `Chrome archive must not contain generated directory entries: ${directoryEntries.join(", ")}`
    );
  }
  const archiveFileIssues = validatePackagedFileSet(Object.keys(zip.files));
  if (archiveFileIssues.length > 0) {
    throw new Error(`Chrome archive file set is invalid:\n- ${archiveFileIssues.join("\n- ")}`);
  }
  const manifestEntry = zip.file("manifest.json");

  if (!manifestEntry) {
    throw new Error(`Chrome archive is missing manifest.json: ${archivePath}`);
  }

  const manifest = JSON.parse(await manifestEntry.async("text"));
  const issues = validateExtensionManifest(manifest, {
    version,
    release: true,
    profile
  });

  if (issues.length > 0) {
    throw new Error(`Chrome archive manifest is invalid:\n- ${issues.join("\n- ")}`);
  }

  return manifest;
}

function validatePackagedFileSet(files) {
  const actual = new Set(files);
  const expected = new Set(REQUIRED_BUILD_FILES);
  const issues = [];

  for (const path of REQUIRED_BUILD_FILES) {
    if (!actual.has(path)) {
      issues.push(`Missing required packaged file '${path}'.`);
    }
  }
  for (const path of [...actual].sort()) {
    if (!expected.has(path)) {
      issues.push(`Unexpected packaged file '${path}'.`);
    }
  }

  return issues;
}

function validateUniqueStringArray(value, fieldName, issues) {
  if (!Array.isArray(value)) {
    issues.push(`${fieldName} must be an array.`);
    return;
  }

  const seen = new Set();

  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      issues.push(`${fieldName} must only contain non-empty strings.`);
      continue;
    }

    if (seen.has(entry)) {
      issues.push(`${fieldName} must not contain duplicate value '${entry}'.`);
      continue;
    }

    seen.add(entry);
  }
}

function validateExactStringArray(
  value,
  expectedValues,
  fieldName,
  issues,
  { missingIssue, unexpectedIssue }
) {
  validateUniqueStringArray(value, fieldName, issues);

  if (!Array.isArray(value)) {
    return;
  }

  const actualValues = new Set(
    value.filter((entry) => typeof entry === "string" && entry.length > 0)
  );
  const expectedValueSet = new Set(expectedValues);

  for (const expectedValue of expectedValues) {
    if (!actualValues.has(expectedValue)) {
      issues.push(missingIssue(expectedValue));
    }
  }

  for (const actualValue of actualValues) {
    if (!expectedValueSet.has(actualValue)) {
      issues.push(unexpectedIssue(actualValue));
    }
  }
}

function validateAbsentOrEmptyArray(manifest, fieldName, issues) {
  if (!Object.hasOwn(manifest ?? {}, fieldName)) {
    return;
  }

  const value = manifest[fieldName];
  if (!Array.isArray(value) || value.length !== 0) {
    issues.push(`Manifest ${fieldName} must be absent or an empty array.`);
  }
}

function validateStoreSafeManifest(manifest, issues) {
  validateExactStringArray(manifest?.permissions, STORE_SAFE_PERMISSIONS, "permissions", issues, {
    missingIssue: (permission) => `Store-safe manifest must include '${permission}' permission.`,
    unexpectedIssue: (permission) => {
      if (permission === "debugger") {
        return "Store-safe manifest must not request the debugger permission.";
      }
      if (permission === "tabs" || permission === "webRequest") {
        return "Store-safe manifest must not request persistent tabs or webRequest access.";
      }
      return `Store-safe manifest must not request undeclared permission '${permission}'.`;
    }
  });

  if (Object.hasOwn(manifest ?? {}, "host_permissions")) {
    const hostPermissions = manifest.host_permissions;
    if (!Array.isArray(hostPermissions) || hostPermissions.length !== 0) {
      issues.push("Store-safe manifest must not declare persistent host_permissions.");
    }
  }

  if (Array.isArray(manifest?.content_scripts) && manifest.content_scripts.length > 0) {
    issues.push("Store-safe manifest must not declare static content_scripts.");
  }
}

function validateDevManifest(manifest, issues) {
  validateExactStringArray(manifest?.permissions, DEV_PERMISSIONS, "permissions", issues, {
    missingIssue: (permission) => `Dev manifest must include '${permission}' permission.`,
    unexpectedIssue: (permission) =>
      `Dev manifest must not request undeclared permission '${permission}'.`
  });

  validateExactStringArray(manifest?.host_permissions, URL_MATCHES, "host_permissions", issues, {
    missingIssue: () => "Dev manifest must include <all_urls> host permission.",
    unexpectedIssue: (hostPermission) =>
      `Dev manifest must not request undeclared host permission '${hostPermission}'.`
  });

  if (Array.isArray(manifest?.content_scripts) && manifest.content_scripts.length > 0) {
    issues.push("Dev manifest must use policy-scoped dynamic content-script injection.");
  }
}

function normalizeManifestProfile(profile) {
  if (EXTENSION_MANIFEST_PROFILES.includes(profile)) {
    return profile;
  }

  throw new Error(`Unknown extension manifest profile: ${profile}`);
}

function inferManifestProfile(manifest) {
  const permissions = new Set(manifest?.permissions ?? []);
  const hasHostPermissions =
    Array.isArray(manifest?.host_permissions) && manifest.host_permissions.length > 0;
  const hasContentScripts =
    Array.isArray(manifest?.content_scripts) && manifest.content_scripts.length > 0;

  if (!permissions.has("debugger") && !hasHostPermissions && !hasContentScripts) {
    return "store-safe";
  }

  return "dev";
}

async function removeStaleArchives(directory, slug, variant, keepPath) {
  const entries = await readdir(directory).catch(() => []);

  await Promise.all(
    entries
      .filter((entry) => isArchiveForVariant(entry, slug, variant))
      .map(async (entry) => {
        const candidatePath = resolve(directory, entry);

        if (candidatePath === keepPath) {
          return;
        }

        await rm(candidatePath, { force: true });
      })
  );
}

function isArchiveForVariant(entry, slug, variant) {
  if (!entry.startsWith(`${slug}-`)) {
    return false;
  }

  if (variant === "enterprise-chrome") {
    return entry.endsWith("-enterprise-chrome.zip");
  }

  return entry.endsWith("-chrome.zip") && !entry.endsWith("-enterprise-chrome.zip");
}

async function listPackagedFiles(rootDir, currentDir = rootDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = resolve(currentDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listPackagedFiles(rootDir, absolutePath)));
      continue;
    }

    if (!entry.isFile() || shouldSkipPackagedFile(entry.name)) {
      continue;
    }

    files.push(relative(rootDir, absolutePath).split(sep).join("/"));
  }

  return files;
}

function shouldSkipPackagedFile(fileName) {
  return ARCHIVE_EXCLUDED_FILE_NAMES.has(fileName) || fileName.endsWith(".map");
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}
