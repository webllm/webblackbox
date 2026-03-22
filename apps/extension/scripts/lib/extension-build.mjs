import { constants } from "node:fs";
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

export const appRoot = resolve(scriptDir, "..", "..");
export const buildDir = resolve(appRoot, "build");
export const distDir = resolve(appRoot, "dist");
export const publicDir = resolve(appRoot, "public");
export const packageJsonPath = resolve(appRoot, "package.json");

const EXTENSION_NAME = "WebBlackbox";
const EXTENSION_DESCRIPTION = "Flight recorder and time-travel debugger for web apps.";
const EXTENSION_MINIMUM_CHROME_VERSION = "125";
const EXTENSION_DEVELOPMENT_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2HDVz1RBsIjEKY/KUOuP3glU4SmMUtvdXXER0JV9mksg6cufsMXUwPpzj7M4aCqCPMV8NkMhRHuGEumnDx/lhc/UI1OUyGpMSP2DSozID5w1s6NY2NbBERcNe0QPwlG9DBkZHHrSXycAHBK8IOaGcsju3Dzmbxr9RI7boLVE0dchdo5bt9tyOxT6LQL1ZlQOgErRf2pSQpU/dqngQ0Wd3/rj5aZ9c04TkycJrXq1FBY4uBiUdFOjuQ6djW4UtJsudYuDaqZ5PsRErilDAbWttkQsN7w5lS7aJANEU/83nIyz8YZ56vn1P1wBqWOxJ2CsyW/lFJdKjgZor6AS5AWCRQIDAQAB";
const EXTENSION_PAGE_CSP =
  "script-src 'self'; object-src 'self'; style-src 'self'; img-src 'self' data:;";
const STATIC_PUBLIC_FILES = [
  "offscreen.html",
  "options.html",
  "popup.html",
  "sessions.html",
  "styles.css",
  "icon"
];
const REQUIRED_BUILD_FILES = [
  "manifest.json",
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
  "alarms",
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

export async function readJson(path) {
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}

export async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readAppPackage() {
  return readJson(packageJsonPath);
}

export function createExtensionManifest({ version, release = false }) {
  return {
    manifest_version: 3,
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
      default_title: EXTENSION_NAME,
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
        description: "Create user marker",
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

export function hasFlag(args, flagName) {
  return args.includes(flagName);
}

export function readFlagValue(args, flagName) {
  const inline = args.find((entry) => entry.startsWith(`${flagName}=`));

  if (inline) {
    return inline.slice(flagName.length + 1);
  }

  const index = args.indexOf(flagName);

  if (index === -1) {
    return null;
  }

  return args[index + 1] ?? null;
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
