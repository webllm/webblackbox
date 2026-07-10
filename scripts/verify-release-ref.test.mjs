import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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

test("rejects mutable or malformed release refs", async () => {
  const root = await createRepository("1.2.3");

  await assert.rejects(
    verifyReleaseRef({ root, tag: "main", mainRef: "main" }),
    /exact semantic version tag/
  );
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

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
