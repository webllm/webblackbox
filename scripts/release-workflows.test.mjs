import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("serializes stable package publishing across release tags", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8"
  );

  assert.match(
    workflow,
    /^concurrency:\n[ ]{2}group: release-stable-publish\n[ ]{2}queue: max\n[ ]{2}cancel-in-progress: false$/m
  );
  assert.doesNotMatch(workflow, /group: release-\$\{\{/);
  assert.match(workflow, /git fetch --force --tags origin main:refs\/remotes\/origin\/main/);
  assert.match(
    workflow,
    /- name: Verify publish artifacts\n[ ]{8}run: pnpm release:verify-artifacts/
  );
  assert.doesNotMatch(workflow, /npm pack --dry-run/);
});

test("serializes release assets and Pages deployments across tags", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release-assets.yml", import.meta.url),
    "utf8"
  );

  assert.match(
    workflow,
    /^concurrency:\n[ ]{2}group: release-assets-stable\n[ ]{2}queue: max\n[ ]{2}cancel-in-progress: false$/m
  );
  assert.match(workflow, /git fetch --force --tags origin main:refs\/remotes\/origin\/main/);
});
