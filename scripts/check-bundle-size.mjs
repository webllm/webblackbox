#!/usr/bin/env node

import { gzipSync } from "node:zlib";
import { lstat, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const budgetsPath = resolve(root, "bundle-size/budgets.json");
const reportPath = resolve(root, "bundle-size/latest-report.json");

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const content = await readFile(budgetsPath, "utf8");
  const budgets = JSON.parse(content);
  const entries = Array.isArray(budgets.entries) ? budgets.entries : [];

  if (entries.length === 0) {
    throw new Error(`No bundle budgets found in ${budgetsPath}`);
  }

  const report = [];
  const failures = [];

  for (const entry of entries) {
    const files = await resolveEntryFiles(entry);
    const label = entry.name ?? entry.path ?? entry.directory;
    let bytes = 0;
    let gzipBytes = 0;

    for (const file of files) {
      const source = await readFile(file);
      bytes += source.byteLength;
      gzipBytes += gzipSync(source).byteLength;
    }

    const maxBytes = Number(entry.maxBytes);
    const maxGzipBytes = Number(entry.maxGzipBytes);

    const rawOk = Number.isFinite(maxBytes) ? bytes <= maxBytes : true;
    const gzipOk = Number.isFinite(maxGzipBytes) ? gzipBytes <= maxGzipBytes : true;

    report.push({
      name: label,
      files: files.map((file) => relative(root, file)),
      bytes,
      gzipBytes,
      maxBytes: Number.isFinite(maxBytes) ? maxBytes : null,
      maxGzipBytes: Number.isFinite(maxGzipBytes) ? maxGzipBytes : null,
      ok: rawOk && gzipOk
    });

    if (!rawOk) {
      failures.push(
        `${label}: raw size ${bytes} exceeds budget ${maxBytes} (+${bytes - maxBytes})`
      );
    }

    if (!gzipOk) {
      failures.push(
        `${label}: gzip size ${gzipBytes} exceeds budget ${maxGzipBytes} (+${gzipBytes - maxGzipBytes})`
      );
    }
  }

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        report
      },
      null,
      2
    ),
    "utf8"
  );

  for (const row of report) {
    console.log(`${row.name}: files=${row.files.length} raw=${row.bytes} gzip=${row.gzipBytes}`);
  }
  console.log("Bundle size report:", reportPath);

  if (failures.length > 0) {
    throw new Error(`Bundle size budgets failed:\n- ${failures.join("\n- ")}`);
  }
}

async function resolveEntryFiles(entry) {
  const hasPath = typeof entry.path === "string" && entry.path.length > 0;
  const hasDirectory = typeof entry.directory === "string" && entry.directory.length > 0;

  if (hasPath === hasDirectory) {
    throw new Error("Each bundle budget must define exactly one of path or directory");
  }

  if (hasPath) {
    const target = resolveInsideRoot(entry.path);
    const fileStats = await lstat(target);
    if (!fileStats.isFile()) {
      throw new Error(`Bundle budget path is not a regular file: ${entry.path}`);
    }
    return [target];
  }

  const extensions = Array.isArray(entry.extensions) ? entry.extensions.map(String) : [".js"];
  if (extensions.length === 0 || extensions.some((value) => !value.startsWith("."))) {
    throw new Error(`Invalid extensions for bundle budget: ${entry.directory}`);
  }

  const files = await collectFiles(resolveInsideRoot(entry.directory), extensions);
  if (files.length === 0) {
    throw new Error(`Bundle budget directory has no matching files: ${entry.directory}`);
  }
  return files;
}

async function collectFiles(directory, extensions) {
  const directoryStats = await lstat(directory);
  if (!directoryStats.isDirectory()) {
    throw new Error(`Bundle budget directory is not a directory: ${relative(root, directory)}`);
  }

  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Bundle budget directory contains a symlink: ${relative(root, target)}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(target, extensions)));
    } else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
      files.push(target);
    }
  }
  return files.sort();
}

function resolveInsideRoot(value) {
  const target = resolve(root, String(value));
  const fromRoot = relative(root, target);
  if (fromRoot.startsWith("..") || fromRoot === "") {
    throw new Error(`Bundle budget target must be inside the repository: ${value}`);
  }
  return target;
}
