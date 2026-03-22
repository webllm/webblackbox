import { cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

import {
  assertExtensionBuild,
  buildDir,
  createExtensionManifest,
  distDir,
  readAppPackage,
  readJson,
  writeJson
} from "./lib/extension-build.mjs";

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
  await runCommand(
    "zip",
    ["-q", "-r", outputPath, ".", "-x", "*.map", ".DS_Store", "*/.DS_Store"],
    uploadDir.path
  );
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

function runCommand(command, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit"
    });

    child.on("error", (error) => {
      rejectPromise(
        new Error(
          `Failed to launch '${command}'. Make sure it is installed and available in PATH. ${error.message}`
        )
      );
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(new Error(`'${command}' exited with code ${code ?? "unknown"}.`));
    });
  });
}
