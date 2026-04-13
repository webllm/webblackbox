import { constants } from "node:fs";
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

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

const PERMISSIONS = [
  "activeTab",
  "cookies",
  "debugger",
  "downloads",
  "offscreen",
  "scripting",
  "storage",
  "tabs",
  "webRequest"
];
const URL_MATCHES = ["<all_urls>"];
const ARCHIVE_FIXED_DATE = new Date("1980-01-01T00:00:00.000Z");
const ARCHIVE_EXCLUDED_FILE_NAMES = new Set([".DS_Store"]);

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

export function createExtensionManifest({ version, release = false }) {
  return {
    manifest_version: 3,
    default_locale: EXTENSION_DEFAULT_LOCALE,
    name: EXTENSION_NAME,
    description: EXTENSION_DESCRIPTION,
    version,
    ...(release ? {} : { key: EXTENSION_DEVELOPMENT_KEY }),
    minimum_chrome_version: EXTENSION_MINIMUM_CHROME_VERSION,
    permissions: [...PERMISSIONS],
    host_permissions: [...URL_MATCHES],
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
    content_scripts: [
      {
        matches: [...URL_MATCHES],
        js: ["content.js"],
        all_frames: true,
        run_at: "document_start"
      }
    ],
    web_accessible_resources: [
      {
        resources: ["injected.js"],
        matches: [...URL_MATCHES]
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
}

export function validateExtensionManifest(manifest, { version, release = false } = {}) {
  const issues = [];

  if (manifest?.manifest_version !== 3) {
    issues.push("manifest_version must be 3.");
  }

  if (manifest?.default_locale !== EXTENSION_DEFAULT_LOCALE) {
    issues.push(`default_locale must be ${EXTENSION_DEFAULT_LOCALE}.`);
  }

  if (version && manifest?.version !== version) {
    issues.push(`Manifest version must match package version ${version}.`);
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
  const injectedResources =
    Array.isArray(webAccessibleResources) && webAccessibleResources.length === 1
      ? webAccessibleResources[0]?.resources
      : null;

  if (!Array.isArray(injectedResources) || injectedResources.join(",") !== "injected.js") {
    issues.push("Manifest must only expose injected.js as a web accessible resource.");
  }

  validateUniqueStringArray(manifest?.permissions, "permissions", issues);
  validateUniqueStringArray(manifest?.host_permissions, "host_permissions", issues);

  return issues;
}

export async function copyPublicAssets(outputDir) {
  await mkdir(outputDir, { recursive: true });

  await Promise.all(
    STATIC_PUBLIC_FILES.map((entry) =>
      cp(resolve(publicDir, entry), resolve(outputDir, entry), { recursive: true })
    )
  );
}

export async function writeGeneratedManifest(outputDir, { release = false } = {}) {
  const appPackage = await readAppPackage();
  const version =
    typeof appPackage?.version === "string" && appPackage.version.length > 0
      ? appPackage.version
      : null;

  if (!version) {
    throw new Error(`Missing version in ${packageJsonPath}`);
  }

  const manifest = createExtensionManifest({ version, release });
  const issues = validateExtensionManifest(manifest, { version, release });

  if (issues.length > 0) {
    throw new Error(`Generated manifest is invalid:\n- ${issues.join("\n- ")}`);
  }

  await writeJson(resolve(outputDir, "manifest.json"), manifest);
  return manifest;
}

export async function assertExtensionBuild(outputDir, { version, release = false } = {}) {
  await Promise.all(
    REQUIRED_BUILD_FILES.map((file) => access(resolve(outputDir, file), constants.R_OK))
  );

  const manifest = await readJson(resolve(outputDir, "manifest.json"));
  const issues = validateExtensionManifest(manifest, { version, release });

  if (issues.length > 0) {
    throw new Error(`Build output manifest is invalid:\n- ${issues.join("\n- ")}`);
  }

  return manifest;
}

export async function prepareBuildOutput({ outputDir = buildDir, release = false } = {}) {
  await copyPublicAssets(outputDir);
  const manifest = await writeGeneratedManifest(outputDir, { release });
  await assertExtensionBuild(outputDir, { version: manifest.version, release });
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

  if (!version) {
    throw new Error(`Missing manifest version in ${resolve(sourceDir, "manifest.json")}`);
  }

  await assertExtensionBuild(sourceDir, { version, release: sourceReleaseBuild });

  const releaseManifest = createExtensionManifest({ version, release: true });
  const releaseIssues = validateExtensionManifest(releaseManifest, { version, release: true });

  if (releaseIssues.length > 0) {
    throw new Error(`Release manifest is invalid:\n- ${releaseIssues.join("\n- ")}`);
  }

  const archiveSlug = slugify(EXTENSION_ARCHIVE_SLUG);
  const resolvedOutputPath = outputPath
    ? resolve(process.cwd(), outputPath)
    : resolve(distDir, `${archiveSlug}-${version}-chrome.zip`);

  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await mkdir(distDir, { recursive: true });

  if (!outputPath) {
    await removeStaleArchives(distDir, archiveSlug, resolvedOutputPath);
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
      date: ARCHIVE_FIXED_DATE
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

  const archiveStat = await stat(resolvedOutputPath);

  return {
    path: resolvedOutputPath,
    bytes: archiveStat.size,
    manifest: {
      name: EXTENSION_ARCHIVE_NAME,
      version: releaseManifest.version
    },
    strippedKeys: Object.hasOwn(sourceManifest ?? {}, "key") ? ["key"] : []
  };
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

async function removeStaleArchives(directory, slug, keepPath) {
  const entries = await readdir(directory).catch(() => []);

  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(`${slug}-`) && entry.endsWith("-chrome.zip"))
      .map(async (entry) => {
        const candidatePath = resolve(directory, entry);

        if (candidatePath === keepPath) {
          return;
        }

        await rm(candidatePath, { force: true });
      })
  );
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
