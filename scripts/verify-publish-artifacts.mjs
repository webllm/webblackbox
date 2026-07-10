import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024 * 1024;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SAFE_PACKAGE_PATH_PATTERN = /^[A-Za-z0-9._@/-]+$/;
const WINDOWS_COMMAND_SHIM_PATTERN = /\.(?:cmd|bat)$/i;
const UNSAFE_WINDOWS_COMMAND_TOKEN_PATTERN = /["&|<>^()%!$`;*?]/u;

export const PUBLIC_PACKAGE_DEFINITIONS = Object.freeze([
  Object.freeze({ name: "@webblackbox/protocol", directory: "packages/protocol" }),
  Object.freeze({ name: "@webblackbox/cdp-router", directory: "packages/cdp-router" }),
  Object.freeze({ name: "@webblackbox/recorder", directory: "packages/recorder" }),
  Object.freeze({ name: "@webblackbox/pipeline", directory: "packages/pipeline" }),
  Object.freeze({ name: "@webblackbox/player-sdk", directory: "packages/player-sdk" }),
  Object.freeze({ name: "webblackbox", directory: "packages/webblackbox" }),
  Object.freeze({
    name: "@webblackbox/mcp-server",
    directory: "apps/mcp-server",
    bin: Object.freeze({ "webblackbox-mcp-server": "./dist/cli.js" })
  })
]);

export const PUBLIC_PACKAGE_NAMES = Object.freeze(
  PUBLIC_PACKAGE_DEFINITIONS.map(({ name }) => name)
);

export function assertNoWorkspaceSpecifiers(manifest) {
  const workspacePaths = [];
  collectWorkspaceSpecifiers(manifest, "$", workspacePaths, new WeakSet());
  if (workspacePaths.length > 0) {
    throw new Error(
      `Packed manifest contains forbidden workspace: specifiers at ${workspacePaths.join(", ")}.`
    );
  }
}

export function assertCompletePackageSet(manifests, expectedNames = PUBLIC_PACKAGE_NAMES) {
  const expected = new Set(expectedNames);
  const counts = new Map();
  const unexpected = [];

  for (const manifest of manifests) {
    const name = manifest?.name;
    if (typeof name !== "string") {
      throw new Error("Packed artifact manifest is missing a string package name.");
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (!expected.has(name)) {
      unexpected.push(name);
    }
  }

  const missing = expectedNames.filter((name) => !counts.has(name));
  const duplicates = [...counts]
    .filter(([, count]) => count !== 1)
    .map(([name, count]) => `${name} (${count})`);
  if (missing.length > 0 || unexpected.length > 0 || duplicates.length > 0) {
    throw new Error(
      [
        missing.length > 0 ? `missing: ${missing.join(", ")}` : null,
        unexpected.length > 0 ? `unexpected: ${unexpected.join(", ")}` : null,
        duplicates.length > 0 ? `duplicates: ${duplicates.join(", ")}` : null
      ]
        .filter(Boolean)
        .join("; ")
    );
  }
}

export function validatePackedManifest({ manifest, entries, expectedPackage }) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Packed artifact for ${expectedPackage.name} has an invalid manifest.`);
  }
  if (manifest.name !== expectedPackage.name || !isValidPackageName(manifest.name)) {
    throw new Error(
      `Packed artifact name ${JSON.stringify(manifest.name)} does not match ${expectedPackage.name}.`
    );
  }
  if (typeof manifest.version !== "string" || !SEMVER_PATTERN.test(manifest.version)) {
    throw new Error(`Packed artifact ${manifest.name} has an invalid version.`);
  }
  if (manifest.private === true) {
    throw new Error(`Packed artifact ${manifest.name} is unexpectedly private.`);
  }

  assertNoWorkspaceSpecifiers(manifest);
  validateTarEntries(entries, manifest.name);
  validateFilesField(manifest, entries);
  validateEntryPoint(manifest, entries, "main");
  validateEntryPoint(manifest, entries, "types");
  validateExportsField(manifest, entries);
  validateBinField(manifest, entries, expectedPackage.bin);
}

export function getPublicExportSpecifiers(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Cannot derive public exports from an invalid manifest.");
  }
  if (!isValidPackageName(manifest.name)) {
    throw new Error("Cannot derive public exports without a valid package name.");
  }

  const exportsField = manifest.exports;
  if (typeof exportsField === "string" || exportsField === null || Array.isArray(exportsField)) {
    return [manifest.name];
  }
  if (!exportsField || typeof exportsField !== "object") {
    throw new Error(`Packed artifact ${manifest.name} must declare exports.`);
  }

  const keys = Object.keys(exportsField);
  const subpathKeys = keys.filter((key) => key.startsWith("."));
  if (subpathKeys.length === 0) {
    return [manifest.name];
  }
  if (subpathKeys.length !== keys.length) {
    throw new Error(`Packed artifact ${manifest.name} mixes export subpaths and conditions.`);
  }

  return subpathKeys.map((key) => {
    if (key === ".") {
      return manifest.name;
    }
    if (!key.startsWith("./")) {
      throw new Error(`Packed artifact ${manifest.name} has invalid export subpath ${key}.`);
    }
    const subpath = normalizePackageRelativePath(key.slice(2), `exports key ${key}`);
    return `${manifest.name}/${subpath}`;
  });
}

export function createCommandRunner({
  platform = process.platform,
  commandInterpreter = process.env.ComSpec || "cmd.exe",
  execFileRunner = execFileAsync
} = {}) {
  return async function runCommand(command, arguments_, options = {}, label = command) {
    const invocation = createCommandInvocation({
      command,
      arguments_,
      platform,
      commandInterpreter
    });

    try {
      const result = await execFileRunner(invocation.command, invocation.arguments, {
        ...options,
        ...invocation.options,
        encoding: "utf8",
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        windowsHide: true
      });
      return {
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? "")
      };
    } catch (error) {
      const stdout =
        error && typeof error === "object" && "stdout" in error ? String(error.stdout) : "";
      const stderr =
        error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
      throw new Error(
        `${label} failed.${stdout ? `\nstdout:\n${stdout}` : ""}${stderr ? `\nstderr:\n${stderr}` : ""}`,
        { cause: error }
      );
    }
  };
}

export async function verifyPublishArtifacts({
  platform = process.platform,
  workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  pnpmCommand = platform === "win32" ? "pnpm.cmd" : "pnpm",
  npmCommand = platform === "win32" ? "npm.cmd" : "npm",
  tarCommand = "tar",
  commandRunner = createCommandRunner({ platform })
} = {}) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "webblackbox-publish-artifacts-"));
  const artifactDirectory = join(temporaryRoot, "tarballs");
  const installDirectory = join(temporaryRoot, "install-smoke");

  try {
    await mkdir(artifactDirectory, { recursive: true });
    const artifacts = [];

    for (const expectedPackage of PUBLIC_PACKAGE_DEFINITIONS) {
      const packageDirectory = resolve(workspaceRoot, expectedPackage.directory);
      const sourceManifest = await readJsonFile(join(packageDirectory, "package.json"));
      if (sourceManifest.name !== expectedPackage.name) {
        throw new Error(
          `Source package at ${expectedPackage.directory} is ${JSON.stringify(sourceManifest.name)}, expected ${expectedPackage.name}.`
        );
      }

      const existingTarballs = new Set(await listTarballs(artifactDirectory));
      await commandRunner(
        pnpmCommand,
        ["pack", "--pack-destination", artifactDirectory],
        { cwd: packageDirectory },
        `packing ${expectedPackage.name}`
      );
      const addedTarballs = (await listTarballs(artifactDirectory)).filter(
        (name) => !existingTarballs.has(name)
      );
      if (addedTarballs.length !== 1) {
        throw new Error(
          `Packing ${expectedPackage.name} produced ${addedTarballs.length} new tarballs instead of one.`
        );
      }

      const tarballPath = join(artifactDirectory, addedTarballs[0]);
      const artifact = await readPackedArtifact(tarballPath, tarCommand, commandRunner);
      validatePackedManifest({
        manifest: artifact.manifest,
        entries: artifact.entries,
        expectedPackage
      });
      if (artifact.manifest.version !== sourceManifest.version) {
        throw new Error(
          `Packed ${expectedPackage.name} version ${artifact.manifest.version} does not match source ${sourceManifest.version}.`
        );
      }
      artifacts.push({ ...artifact, tarballPath, expectedPackage });
    }

    assertCompletePackageSet(artifacts.map(({ manifest }) => manifest));
    const versions = new Set(artifacts.map(({ manifest }) => manifest.version));
    if (versions.size !== 1) {
      throw new Error(
        `Public package artifacts are not versioned in lockstep: ${[...versions].join(", ")}.`
      );
    }

    const importSpecifiers = artifacts
      .filter(({ expectedPackage }) => expectedPackage.bin === undefined)
      .flatMap(({ manifest }) => getPublicExportSpecifiers(manifest));
    if (new Set(importSpecifiers).size !== importSpecifiers.length) {
      throw new Error("Public package artifacts expose duplicate import specifiers.");
    }

    await installAndSmokeArtifacts({
      artifacts,
      importSpecifiers,
      installDirectory,
      npmCommand,
      platform,
      commandRunner
    });
    const version = artifacts[0]?.manifest.version;
    console.log(
      `Verified ${artifacts.length} publish artifacts at version ${version}: manifests, isolated install, ${importSpecifiers.length} public export imports, and MCP bin smoke passed.`
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function readPackedArtifact(tarballPath, tarCommand, commandRunner) {
  const listing = await commandRunner(
    tarCommand,
    ["-tzf", tarballPath],
    undefined,
    `listing ${basename(tarballPath)}`
  );
  const entries = listing.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.filter((entry) => entry === "package/package.json").length !== 1) {
    throw new Error(`${basename(tarballPath)} must contain exactly one package/package.json.`);
  }

  const manifestResult = await commandRunner(
    tarCommand,
    ["-xOzf", tarballPath, "package/package.json"],
    undefined,
    `reading ${basename(tarballPath)} package.json`
  );
  let manifest;
  try {
    manifest = JSON.parse(manifestResult.stdout);
  } catch (error) {
    throw new Error(`${basename(tarballPath)} contains invalid package.json JSON.`, {
      cause: error
    });
  }
  return { manifest, entries };
}

async function installAndSmokeArtifacts({
  artifacts,
  importSpecifiers,
  installDirectory,
  npmCommand,
  platform,
  commandRunner
}) {
  await mkdir(installDirectory, { recursive: true });
  await writeFile(
    join(installDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "webblackbox-publish-artifact-smoke",
        version: "0.0.0",
        private: true,
        type: "module"
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await commandRunner(
    npmCommand,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      "--package-lock=false",
      ...artifacts.map(({ tarballPath }) => tarballPath)
    ],
    {
      cwd: installDirectory,
      env: {
        ...process.env,
        npm_config_update_notifier: "false"
      }
    },
    "installing packed artifacts"
  );

  for (const { manifest } of artifacts) {
    const installedManifest = await readJsonFile(
      join(installDirectory, "node_modules", ...manifest.name.split("/"), "package.json")
    );
    if (installedManifest.version !== manifest.version) {
      throw new Error(
        `Installed ${manifest.name} version ${installedManifest.version} does not match packed ${manifest.version}.`
      );
    }
  }

  const smokeScriptPath = join(installDirectory, "import-smoke.mjs");
  await writeFile(
    smokeScriptPath,
    `const importSpecifiers = ${JSON.stringify(importSpecifiers)};
for (const specifier of importSpecifiers) {
  const namespace = await import(specifier);
  if (!namespace || typeof namespace !== "object") {
    throw new Error(\`Import did not return a module namespace: \${specifier}\`);
  }
}
console.log(\`Imported \${importSpecifiers.length} public package exports.\`);
`,
    "utf8"
  );
  await commandRunner(
    process.execPath,
    [smokeScriptPath],
    { cwd: installDirectory },
    "import smoke"
  );

  const mcpArtifact = artifacts.find(({ manifest }) => manifest.name === "@webblackbox/mcp-server");
  if (!mcpArtifact) {
    throw new Error("MCP server artifact is missing from the install smoke.");
  }
  const binName = Object.keys(mcpArtifact.expectedPackage.bin ?? {})[0];
  const binPath = join(
    installDirectory,
    "node_modules",
    ".bin",
    platform === "win32" ? `${binName}.cmd` : binName
  );
  await access(binPath, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
  const binResult = await commandRunner(
    binPath,
    ["--version"],
    { cwd: installDirectory },
    "MCP bin smoke"
  );
  if (binResult.stdout.trim() !== mcpArtifact.manifest.version || binResult.stderr.trim() !== "") {
    throw new Error(
      `MCP bin --version returned ${JSON.stringify(binResult.stdout.trim())} with stderr ${JSON.stringify(binResult.stderr.trim())}.`
    );
  }
}

function validateTarEntries(entries, packageName) {
  if (entries.length === 0) {
    throw new Error(`Packed artifact ${packageName} is empty.`);
  }
  for (const entry of entries) {
    const normalized = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    if (!normalized.startsWith("package/") || !isSafePackageRelativePath(normalized.slice(8))) {
      throw new Error(`Packed artifact ${packageName} contains unsafe tar entry ${entry}.`);
    }
  }
}

function validateFilesField(manifest, entries) {
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`Packed artifact ${manifest.name} must declare a non-empty files array.`);
  }
  const normalizedFiles = manifest.files.map((value) =>
    normalizePackageRelativePath(value, "files")
  );
  if (new Set(normalizedFiles).size !== normalizedFiles.length) {
    throw new Error(`Packed artifact ${manifest.name} has duplicate files entries.`);
  }
  for (const filePath of normalizedFiles) {
    const archivePath = `package/${filePath}`;
    if (
      !entries.some(
        (entry) => entry.replace(/\/$/, "") === archivePath || entry.startsWith(`${archivePath}/`)
      )
    ) {
      throw new Error(
        `Packed artifact ${manifest.name} files entry ${filePath} matched no content.`
      );
    }
  }
}

function validateEntryPoint(manifest, entries, fieldName) {
  const rawPath = manifest[fieldName];
  if (typeof rawPath !== "string") {
    throw new Error(`Packed artifact ${manifest.name} must declare a string ${fieldName}.`);
  }
  validateArchiveTarget(manifest, entries, rawPath, fieldName);
}

function validateExportsField(manifest, entries) {
  if (manifest.exports === undefined) {
    throw new Error(`Packed artifact ${manifest.name} must declare exports.`);
  }

  getPublicExportSpecifiers(manifest);
  const localTargets = [];
  collectExportTargets(manifest.exports, "exports", localTargets);
  if (localTargets.length === 0) {
    throw new Error(`Packed artifact ${manifest.name} exports no local targets.`);
  }
  for (const { path, target } of localTargets) {
    validateArchiveTarget(manifest, entries, target, path);
  }
}

function collectExportTargets(value, path, results) {
  if (typeof value === "string") {
    if (!value.startsWith("./")) {
      throw new Error(
        `Packed manifest ${path} must be a local target, received ${JSON.stringify(value)}.`
      );
    }
    results.push({ path, target: value });
    return;
  }
  if (value === null) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectExportTargets(entry, `${path}[${index}]`, results));
    return;
  }
  if (!value || typeof value !== "object") {
    throw new Error(`Packed manifest ${path} has an invalid exports target.`);
  }
  for (const [key, entry] of Object.entries(value)) {
    collectExportTargets(entry, `${path}.${key}`, results);
  }
}

function validateArchiveTarget(manifest, entries, rawPath, fieldName) {
  const filePath = normalizePackageRelativePath(rawPath, fieldName);
  if (!entries.includes(`package/${filePath}`)) {
    throw new Error(`Packed artifact ${manifest.name} ${fieldName} target ${filePath} is missing.`);
  }
}

function validateBinField(manifest, entries, expectedBin) {
  const bin = normalizeBin(manifest);
  const expected = expectedBin ?? {};
  if (JSON.stringify(bin) !== JSON.stringify(expected)) {
    throw new Error(
      `Packed artifact ${manifest.name} bin ${JSON.stringify(bin)} does not match ${JSON.stringify(expected)}.`
    );
  }
  for (const [command, rawPath] of Object.entries(bin)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(command)) {
      throw new Error(`Packed artifact ${manifest.name} has invalid bin command ${command}.`);
    }
    validateArchiveTarget(manifest, entries, rawPath, `bin.${command}`);
  }
}

function normalizeBin(manifest) {
  if (manifest.bin === undefined) {
    return {};
  }
  if (typeof manifest.bin === "string") {
    const unscopedName = manifest.name.includes("/") ? manifest.name.split("/")[1] : manifest.name;
    return { [unscopedName]: manifest.bin };
  }
  if (!manifest.bin || typeof manifest.bin !== "object" || Array.isArray(manifest.bin)) {
    throw new Error(`Packed artifact ${manifest.name} has an invalid bin field.`);
  }
  return Object.fromEntries(
    Object.entries(manifest.bin).sort(([left], [right]) => left.localeCompare(right))
  );
}

function normalizePackageRelativePath(value, fieldName) {
  if (typeof value !== "string") {
    throw new Error(`Packed manifest ${fieldName} must contain strings.`);
  }
  const normalized = value.replace(/^\.\//, "");
  if (!isSafePackageRelativePath(normalized)) {
    throw new Error(`Packed manifest ${fieldName} contains unsafe path ${JSON.stringify(value)}.`);
  }
  return normalized;
}

function isSafePackageRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    SAFE_PACKAGE_PATH_PATTERN.test(value) &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

function isValidPackageName(value) {
  return typeof value === "string" && value.length <= 214 && PACKAGE_NAME_PATTERN.test(value);
}

function collectWorkspaceSpecifiers(value, path, results, seen) {
  if (typeof value === "string") {
    if (value.trim().startsWith("workspace:")) {
      results.push(path);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectWorkspaceSpecifiers(entry, `${path}[${index}]`, results, seen)
    );
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    collectWorkspaceSpecifiers(entry, `${path}.${key}`, results, seen);
  }
}

async function listTarballs(directory) {
  return (await readdir(directory)).filter((name) => name.endsWith(".tgz")).sort();
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function createCommandInvocation({ command, arguments_, platform, commandInterpreter }) {
  if (platform !== "win32" || !WINDOWS_COMMAND_SHIM_PATTERN.test(command)) {
    return { command, arguments: arguments_, options: {} };
  }
  if (typeof commandInterpreter !== "string" || commandInterpreter.length === 0) {
    throw new Error("Windows command interpreter must be a non-empty string.");
  }

  const commandLine = [command, ...arguments_].map(quoteWindowsCommandToken).join(" ");
  return {
    command: commandInterpreter,
    arguments: ["/d", "/s", "/v:off", "/c", `"${commandLine}"`],
    options: { windowsVerbatimArguments: true }
  };
}

function quoteWindowsCommandToken(value) {
  if (typeof value !== "string") {
    throw new Error("Windows command shim arguments must be strings.");
  }
  if (
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    }) ||
    UNSAFE_WINDOWS_COMMAND_TOKEN_PATTERN.test(value)
  ) {
    throw new Error(`Unsafe Windows command shim token: ${JSON.stringify(value)}.`);
  }

  const escapedTrailingBackslashes = value.replace(/(\\+)$/, "$1$1");
  return `"${escapedTrailingBackslashes}"`;
}

function isDirectInvocation() {
  return (
    process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

if (isDirectInvocation()) {
  verifyPublishArtifacts().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
