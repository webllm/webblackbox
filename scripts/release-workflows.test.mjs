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
  const chromeJob = workflow.slice(
    workflow.indexOf("  chrome-extension:"),
    workflow.indexOf("  player-pages:")
  );
  const playerJob = workflow.slice(workflow.indexOf("  player-pages:"));
  const verifiedCheckout = /ref: \$\{\{ needs\.verify-release\.outputs\.verified_sha \}\}/;

  assert.match(
    workflow,
    /^concurrency:\n[ ]{2}group: release-assets-stable\n[ ]{2}queue: max\n[ ]{2}cancel-in-progress: false$/m
  );
  assert.match(workflow, /git fetch --force --tags origin main:refs\/remotes\/origin\/main/);
  assert.match(
    workflow,
    /outputs:\n[ ]{6}verified_sha: \$\{\{ steps\.verified_source\.outputs\.sha \}\}/
  );
  assert.match(
    workflow,
    /- name: Export verified release commit\n[ ]{8}id: verified_source\n[ ]{8}run: echo "sha=\$\(git rev-parse HEAD\)" >> "\$GITHUB_OUTPUT"/
  );
  assert.ok(
    workflow.indexOf("- name: Export verified release commit") >
      workflow.indexOf("- name: Verify successful CI for release commit")
  );
  assert.match(chromeJob, verifiedCheckout);
  assert.match(playerJob, verifiedCheckout);
  assert.equal(workflow.match(new RegExp(verifiedCheckout.source, "g"))?.length, 2);
  assert.doesNotMatch(chromeJob, /ref: \$\{\{ github\.event_name/);
  assert.doesNotMatch(playerJob, /ref: \$\{\{ github\.event_name/);
});
