#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const releaseTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const privateReleaseSurfaces = new Map([
  ["apps/extension", "@webblackbox/extension"],
  ["apps/player", "@webblackbox/player"],
  ["apps/share-server", "@webblackbox/share-server"]
]);

export async function verifyReleaseRef({ root, tag, mainRef = "origin/main" }) {
  const expectedVersion = parseReleaseVersion(tag);
  if (!expectedVersion) {
    throw new Error(
      `Release tag must be an exact semantic version tag (vX.Y.Z) compatible with Chrome (components 0..65535 and not all zero): ${tag}`
    );
  }

  const tagRef = `refs/tags/${tag}^{commit}`;
  const tagCommit = runGit(root, ["rev-parse", "--verify", tagRef]);
  const headCommit = runGit(root, ["rev-parse", "HEAD"]);

  if (tagCommit !== headCommit) {
    throw new Error(`Checked-out commit ${headCommit} does not match ${tag} (${tagCommit})`);
  }

  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", tagCommit, mainRef], {
    cwd: root,
    encoding: "utf8"
  });
  if (ancestor.status !== 0) {
    throw new Error(`Release commit ${tagCommit} is not contained in ${mainRef}`);
  }

  const packages = await readReleasePackages(root);
  if (!packages.some((entry) => !entry.private)) {
    throw new Error("No public packages were found for release verification");
  }

  const mismatches = packages.filter((entry) => entry.version !== expectedVersion);
  if (mismatches.length > 0) {
    throw new Error(
      `Release package versions must match ${tag}: ${mismatches
        .map((entry) => `${entry.name}@${entry.version}`)
        .join(", ")}`
    );
  }

  return {
    tag,
    commit: tagCommit,
    version: expectedVersion,
    packages: packages.map((entry) => entry.name).sort()
  };
}

function parseReleaseVersion(tag) {
  const match = releaseTagPattern.exec(tag);
  if (!match) {
    return undefined;
  }

  const components = match.slice(1).map(Number);
  if (components.some((component) => !Number.isSafeInteger(component) || component > 65_535)) {
    return undefined;
  }
  if (components.every((component) => component === 0)) {
    return undefined;
  }

  return tag.slice(1);
}

async function readReleasePackages(root) {
  const packages = [];
  const foundPrivateReleaseSurfaces = new Set();
  for (const parent of ["packages", "apps"]) {
    const parentPath = resolve(root, parent);
    const entries = await readdir(parentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const packagePath = resolve(parentPath, entry.name, "package.json");
      let manifest;
      try {
        manifest = JSON.parse(await readFile(packagePath, "utf8"));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }

      const packageDirectory = `${parent}/${entry.name}`;
      const expectedPrivateReleaseName = privateReleaseSurfaces.get(packageDirectory);
      if (manifest.private === true && !expectedPrivateReleaseName) {
        continue;
      }
      if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
        throw new Error(`Invalid release package manifest: ${packagePath}`);
      }
      if (expectedPrivateReleaseName && manifest.name !== expectedPrivateReleaseName) {
        throw new Error(
          `Invalid private release surface manifest: expected ${expectedPrivateReleaseName} at ${packagePath}`
        );
      }
      if (expectedPrivateReleaseName) {
        foundPrivateReleaseSurfaces.add(packageDirectory);
      }
      packages.push({
        name: manifest.name,
        version: manifest.version,
        private: manifest.private === true
      });
    }
  }

  const missingPrivateReleaseSurfaces = [...privateReleaseSurfaces.keys()].filter(
    (packageDirectory) => !foundPrivateReleaseSurfaces.has(packageDirectory)
  );
  if (missingPrivateReleaseSurfaces.length > 0) {
    throw new Error(
      `Missing private release surface manifests: ${missingPrivateReleaseSurfaces.join(", ")}`
    );
  }

  return packages;
}

function runGit(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const root = resolve(dirname(scriptPath), "..");
  const tag = process.argv[2] ?? "";
  const mainRef = process.argv[3] ?? "origin/main";

  verifyReleaseRef({ root, tag, mainRef })
    .then((result) => {
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
