import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(root, "..");
const packageJsonPath = resolve(appRoot, "package.json");
const manifestPaths = [
  resolve(appRoot, "public", "manifest.json"),
  resolve(appRoot, "build", "manifest.json")
];

const appPackage = await readJson(packageJsonPath);
const packageVersion =
  typeof appPackage?.version === "string" && appPackage.version.length > 0
    ? appPackage.version
    : null;

if (!packageVersion) {
  throw new Error(`Missing version in ${packageJsonPath}`);
}

const updated = [];

for (const manifestPath of manifestPaths) {
  const exists = await fileExists(manifestPath);

  if (!exists) {
    continue;
  }

  const manifest = await readJson(manifestPath);

  if (manifest?.version === packageVersion) {
    continue;
  }

  manifest.version = packageVersion;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  updated.push(manifestPath);
}

console.info(
  JSON.stringify(
    {
      ok: true,
      version: packageVersion,
      updated
    },
    null,
    2
  )
);

async function readJson(path) {
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}

async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
