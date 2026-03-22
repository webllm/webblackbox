import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import JSZip from "jszip";

import {
  assertExtensionBuild,
  buildDir,
  createExtensionManifest,
  distDir,
  readAppPackage,
  readJson,
  writeJson
} from "./lib/extension-build.mjs";

const ARCHIVE_FIXED_DATE = new Date("1980-01-01T00:00:00.000Z");
const ARCHIVE_EXCLUDED_FILE_NAMES = new Set([".DS_Store"]);

const args = process.argv.slice(2);
const outputArg = readFlagValue(args, "--output");

const appPackage = await readAppPackage();
const manifest = await readJson(resolve(buildDir, "manifest.json"));
await stat(buildDir);
const packageVersion =
  typeof appPackage?.version === "string" && appPackage.version.length > 0
    ? appPackage.version
    : null;
const archiveVersion =
  packageVersion ?? (typeof manifest.version === "string" ? manifest.version : "0.0.0");
const archiveSlug = slugify(typeof manifest.name === "string" ? manifest.name : "webblackbox");

const outputPath = outputArg
  ? resolve(process.cwd(), outputArg)
  : resolve(distDir, `${archiveSlug}-${archiveVersion}-chrome.zip`);

await mkdir(dirname(outputPath), { recursive: true });
await mkdir(distDir, { recursive: true });
if (!outputArg) {
  await removeStaleArchives(distDir, archiveSlug, outputPath);
}
await rm(outputPath, { force: true });

const uploadDir = await prepareUploadDirectory(buildDir, {
  version: archiveVersion,
  strippedKeys: Object.hasOwn(manifest, "key") ? ["key"] : []
});

try {
  await createArchiveFromDirectory(uploadDir.path, outputPath);
} finally {
  await rm(uploadDir.path, { recursive: true, force: true });
}

const archive = await stat(outputPath);

console.info(
  JSON.stringify(
    {
      ok: true,
      archive: outputPath,
      bytes: archive.size,
      manifest: {
        name: manifest.name,
        version: manifest.version
      },
      uploadManifest: {
        strippedKeys: uploadDir.strippedKeys
      },
      package: {
        version: packageVersion
      }
    },
    null,
    2
  )
);

function readFlagValue(argv, flagName) {
  const inline = argv.find((entry) => entry.startsWith(`${flagName}=`));

  if (inline) {
    return inline.slice(flagName.length + 1);
  }

  const index = argv.indexOf(flagName);

  if (index === -1) {
    return null;
  }

  return argv[index + 1] ?? null;
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

async function prepareUploadDirectory(sourceDir, { version, strippedKeys }) {
  const stagingDir = await mkdtemp(resolve(tmpdir(), "webblackbox-extension-upload-"));

  await cp(sourceDir, stagingDir, { recursive: true });

  await writeJson(
    resolve(stagingDir, "manifest.json"),
    createExtensionManifest({
      version,
      release: true
    })
  );
  await assertExtensionBuild(stagingDir, { version, release: true });

  return {
    path: stagingDir,
    strippedKeys
  };
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

async function createArchiveFromDirectory(sourceDir, outputPath) {
  const zip = new JSZip();
  const files = await listPackagedFiles(sourceDir);

  for (const relativePath of files) {
    const bytes = await readFile(resolve(sourceDir, relativePath));
    zip.file(relativePath, bytes, {
      binary: true,
      date: ARCHIVE_FIXED_DATE
    });
  }

  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: {
      level: 6
    },
    platform: "UNIX"
  });

  await writeFile(outputPath, bytes);
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
