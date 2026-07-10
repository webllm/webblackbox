#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(workspaceRoot, "packages/player-sdk");
const committedDocsRoot = join(workspaceRoot, "docs/api/player-sdk");

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "webblackbox-api-docs-"));
  const generatedDocsRoot = join(temporaryRoot, "player-sdk");

  try {
    const result = spawnSync(
      "pnpm",
      ["exec", "typedoc", "--options", "typedoc.json", "--out", generatedDocsRoot],
      {
        cwd: packageRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    if (result.status !== 0) {
      throw new Error(
        `TypeDoc generation failed.\n${result.stderr || result.stdout || "No output was produced."}`
      );
    }

    const committedFiles = await collectFiles(committedDocsRoot);
    const generatedFiles = await collectFiles(generatedDocsRoot);
    const differences = [];

    for (const path of generatedFiles) {
      if (!committedFiles.has(path)) {
        differences.push(`missing committed file: ${path}`);
        continue;
      }

      const [committed, generated] = await Promise.all([
        readFile(join(committedDocsRoot, path)),
        readFile(join(generatedDocsRoot, path))
      ]);
      if (!committed.equals(generated)) {
        differences.push(`changed file: ${path}`);
      }
    }

    for (const path of committedFiles) {
      if (!generatedFiles.has(path)) {
        differences.push(`stale committed file: ${path}`);
      }
    }

    if (differences.length > 0) {
      const preview = differences
        .slice(0, 30)
        .map((entry) => `- ${entry}`)
        .join("\n");
      const omitted = Math.max(0, differences.length - 30);
      throw new Error(
        `Player SDK API documentation is stale. Run 'pnpm docs:api' and commit the result.\n${preview}${omitted > 0 ? `\n- ...and ${omitted} more` : ""}`
      );
    }

    console.log(`Player SDK API documentation matches ${generatedFiles.size} generated files.`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function collectFiles(root) {
  const files = new Set();
  const directories = [root];

  while (directories.length > 0) {
    const current = directories.pop();
    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        directories.push(fullPath);
      } else if (entry.isFile()) {
        files.add(relative(root, fullPath));
      }
    }
  }

  return files;
}
