import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { verifyReleaseRef } from "./verify-release-ref.mjs";

test("accepts an exact release tag on the main history with matching package versions", async () => {
  const root = await createRepository("1.2.3");
  git(root, "tag", "v1.2.3");

  const result = await verifyReleaseRef({ root, tag: "v1.2.3", mainRef: "main" });

  assert.equal(result.version, "1.2.3");
  assert.deepEqual(result.packages, [
    "@example/library",
    "@webblackbox/extension",
    "@webblackbox/player",
    "@webblackbox/share-server"
  ]);
});

test("accepts the Chrome extension version component boundary", async () => {
  const root = await createRepository("65535.65535.65535");
  git(root, "tag", "v65535.65535.65535");

  const result = await verifyReleaseRef({
    root,
    tag: "v65535.65535.65535",
    mainRef: "main"
  });

  assert.equal(result.version, "65535.65535.65535");
});

test("rejects mutable or malformed release refs", async () => {
  const root = await createRepository("1.2.3");

  await assert.rejects(
    verifyReleaseRef({ root, tag: "main", mainRef: "main" }),
    /exact semantic version tag/
  );
});

test("rejects prerelease and build-metadata tags", async () => {
  const root = await createRepository("1.2.3");

  for (const tag of ["v1.2.3-beta.1", "v1.2.3+build.7", "v1.2.3-beta.1+build.7"]) {
    await assert.rejects(
      verifyReleaseRef({ root, tag, mainRef: "main" }),
      /exact semantic version tag \(vX\.Y\.Z\)/
    );
  }
});

test("rejects Chrome-incompatible stable versions", async () => {
  for (const version of ["0.0.0", "65536.1.0"]) {
    const root = await createRepository(version);
    git(root, "tag", `v${version}`);

    await assert.rejects(
      verifyReleaseRef({ root, tag: `v${version}`, mainRef: "main" }),
      /compatible with Chrome/
    );
  }
});

test("rejects a checkout that is newer than the requested tag", async () => {
  const root = await createRepository("1.2.3");
  git(root, "tag", "v1.2.3");
  await writeFile(resolve(root, "after-tag.txt"), "newer\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "after tag");

  await assert.rejects(
    verifyReleaseRef({ root, tag: "v1.2.3", mainRef: "main" }),
    /does not match/
  );
});

test("rejects a tagged commit outside the main branch history", async () => {
  const root = await createRepository("1.2.3");
  git(root, "checkout", "-b", "release-candidate");
  await writeFile(resolve(root, "candidate.txt"), "candidate\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "candidate");
  git(root, "tag", "v1.2.3");

  await assert.rejects(
    verifyReleaseRef({ root, tag: "v1.2.3", mainRef: "main" }),
    /not contained in main/
  );
});

test("rejects a stable release tag superseded by a newer stable tag on main", async () => {
  const root = await createRepository("1.2.3");
  git(root, "tag", "v1.2.3");
  await updateRepositoryVersion(root, "1.10.0");
  git(root, "add", ".");
  git(root, "commit", "-m", "newer stable release");
  git(root, "tag", "v1.10.0");
  git(root, "checkout", "--detach", "v1.2.3");

  await assert.rejects(
    verifyReleaseRef({ root, tag: "v1.2.3", mainRef: "main" }),
    /v1\.2\.3 is superseded by v1\.10\.0/
  );
});

test("ignores non-stable tags when checking for a superseding release", async () => {
  const root = await createRepository("1.2.3");
  git(root, "tag", "v1.2.3");
  await writeFile(resolve(root, "prerelease.txt"), "candidate\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "prerelease candidate");
  git(root, "tag", "v1.3.0-beta.1");
  git(root, "checkout", "--detach", "v1.2.3");

  const result = await verifyReleaseRef({ root, tag: "v1.2.3", mainRef: "main" });

  assert.equal(result.version, "1.2.3");
});

test("rejects tags whose public package versions do not match", async () => {
  const root = await createRepository("1.2.4");
  git(root, "tag", "v1.2.3");

  await assert.rejects(
    verifyReleaseRef({ root, tag: "v1.2.3", mainRef: "main" }),
    /Release package versions must match/
  );
});

test("rejects tags whose private release surface versions do not match", async () => {
  const root = await createRepository("1.2.3", {
    privateVersions: {
      player: "1.2.2"
    }
  });
  git(root, "tag", "v1.2.3");

  await assert.rejects(
    verifyReleaseRef({ root, tag: "v1.2.3", mainRef: "main" }),
    /@webblackbox\/player@1\.2\.2/
  );
});

async function createRepository(version, options = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "webblackbox-release-ref-"));
  await mkdir(resolve(root, "packages", "library"), { recursive: true });
  await mkdir(resolve(root, "apps", "extension"), { recursive: true });
  await mkdir(resolve(root, "apps", "player"), { recursive: true });
  await mkdir(resolve(root, "apps", "share-server"), { recursive: true });
  await writeFile(
    resolve(root, "packages", "library", "package.json"),
    `${JSON.stringify({ name: "@example/library", version }, null, 2)}\n`
  );
  const privateVersions = options.privateVersions ?? {};
  await writeFile(
    resolve(root, "apps", "extension", "package.json"),
    `${JSON.stringify(
      {
        name: "@webblackbox/extension",
        version: privateVersions.extension ?? version,
        private: true
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    resolve(root, "apps", "player", "package.json"),
    `${JSON.stringify(
      {
        name: "@webblackbox/player",
        version: privateVersions.player ?? version,
        private: true
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    resolve(root, "apps", "share-server", "package.json"),
    `${JSON.stringify(
      {
        name: "@webblackbox/share-server",
        version: privateVersions.shareServer ?? version,
        private: true
      },
      null,
      2
    )}\n`
  );
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "Release Test");
  git(root, "config", "user.email", "release-test@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  return root;
}

async function updateRepositoryVersion(root, version) {
  for (const relativePath of [
    "packages/library/package.json",
    "apps/extension/package.json",
    "apps/player/package.json",
    "apps/share-server/package.json"
  ]) {
    const manifestPath = resolve(root, relativePath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  }
}

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
