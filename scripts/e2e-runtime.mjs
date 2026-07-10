import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { posix, win32 } from "node:path";

const WINDOWS_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export function extensionChromeLoadArgs(extensionDirectory) {
  if (typeof extensionDirectory !== "string" || extensionDirectory.trim().length === 0) {
    throw new TypeError("Extension E2E directory must be a non-empty path.");
  }

  return [
    // Chrome 137+ blocks --load-extension in branded builds. Keeping the
    // disable-extensions-except path enabled preserves unpacked E2E loading,
    // while unbranded Chromium continues to honor --load-extension directly.
    "--disable-features=DisableDisableExtensionsExceptCommandLineSwitch",
    `--disable-extensions-except=${extensionDirectory}`,
    `--load-extension=${extensionDirectory}`
  ];
}

export function createE2eTempPath(
  prefix,
  extension = "",
  {
    temporaryDirectory = tmpdir(),
    processId = process.pid,
    timestamp = Date.now(),
    platform = process.platform
  } = {}
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(prefix)) {
    throw new TypeError(`Invalid E2E temporary-path prefix: ${prefix}`);
  }
  if (extension !== "" && !/^\.[A-Za-z0-9]{1,16}$/.test(extension)) {
    throw new TypeError(`Invalid E2E temporary-path extension: ${extension}`);
  }
  if (!Number.isSafeInteger(processId) || processId < 0) {
    throw new TypeError("E2E temporary-path process id must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError("E2E temporary-path timestamp must be a non-negative safe integer.");
  }

  return pathApiForPlatform(platform).join(
    temporaryDirectory,
    `${prefix}-${processId}-${timestamp}${extension}`
  );
}

export function executableSearchPaths(
  candidate,
  {
    platform = process.platform,
    pathValue = process.env.PATH ?? "",
    pathExtValue = process.env.PATHEXT ?? WINDOWS_DEFAULT_PATHEXT
  } = {}
) {
  if (typeof candidate !== "string") {
    return [];
  }

  const command = stripMatchingQuotes(candidate);
  if (command.length === 0) {
    return [];
  }
  const pathApi = pathApiForPlatform(platform);
  if (
    pathApi.isAbsolute(command) ||
    command.startsWith(".") ||
    command.includes("/") ||
    command.includes("\\")
  ) {
    return [command];
  }

  const separator = platform === "win32" ? ";" : ":";
  const directories = String(pathValue)
    .split(separator)
    .map(stripMatchingQuotes)
    .filter((directory) => directory.length > 0);
  const commandNames =
    platform === "win32" ? windowsCommandNames(command, pathExtValue, pathApi) : [command];
  const paths = [];
  const seen = new Set();

  for (const directory of directories) {
    for (const commandName of commandNames) {
      const path = pathApi.join(directory, commandName);
      const key = platform === "win32" ? path.toLowerCase() : path;
      if (!seen.has(key)) {
        seen.add(key);
        paths.push(path);
      }
    }
  }

  return paths;
}

export async function resolveExecutable(
  candidate,
  {
    accessImplementation = access,
    platform = process.platform,
    pathValue = process.env.PATH ?? "",
    pathExtValue = process.env.PATHEXT ?? WINDOWS_DEFAULT_PATHEXT
  } = {}
) {
  for (const path of executableSearchPaths(candidate, { platform, pathValue, pathExtValue })) {
    try {
      await accessImplementation(path, constants.X_OK);
      return path;
    } catch {
      // Continue searching the remaining explicit/PATH candidates.
    }
  }

  return null;
}

function windowsCommandNames(command, pathExtValue, pathApi) {
  const extensions = String(pathExtValue)
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => /^\.[A-Za-z0-9]+$/.test(extension));
  const normalizedExtensions = extensions.length > 0 ? extensions : [".EXE"];
  const commandExtension = pathApi.extname(command).toLowerCase();

  if (
    commandExtension &&
    normalizedExtensions.some((extension) => extension.toLowerCase() === commandExtension)
  ) {
    return [command];
  }

  return normalizedExtensions.map((extension) => `${command}${extension}`);
}

function stripMatchingQuotes(value) {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

function pathApiForPlatform(platform) {
  return platform === "win32" ? win32 : posix;
}
