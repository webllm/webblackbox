#!/usr/bin/env node

import { gzipSync } from "node:zlib";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
    const target = resolve(root, String(entry.path));
    const fileStats = await stat(target);
    const bytes = fileStats.size;
    const source = await readFile(target);
    const gzipBytes = gzipSync(source).byteLength;
    const maxBytes = Number(entry.maxBytes);
    const maxGzipBytes = Number(entry.maxGzipBytes);

    const rawOk = Number.isFinite(maxBytes) ? bytes <= maxBytes : true;
    const gzipOk = Number.isFinite(maxGzipBytes) ? gzipBytes <= maxGzipBytes : true;

    report.push({
      path: entry.path,
      bytes,
      gzipBytes,
      maxBytes: Number.isFinite(maxBytes) ? maxBytes : null,
      maxGzipBytes: Number.isFinite(maxGzipBytes) ? maxGzipBytes : null,
      ok: rawOk && gzipOk
    });

    if (!rawOk) {
      failures.push(
        `${entry.path}: raw size ${bytes} exceeds budget ${maxBytes} (+${bytes - maxBytes})`
      );
    }

    if (!gzipOk) {
      failures.push(
        `${entry.path}: gzip size ${gzipBytes} exceeds budget ${maxGzipBytes} (+${gzipBytes - maxGzipBytes})`
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
    console.log(`${row.path}: raw=${row.bytes} gzip=${row.gzipBytes}`);
  }
  console.log("Bundle size report:", reportPath);

  if (failures.length > 0) {
    throw new Error(`Bundle size budgets failed:\n- ${failures.join("\n- ")}`);
  }
}
