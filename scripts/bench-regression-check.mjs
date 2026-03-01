#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const thresholdsPath = resolve(root, "benchmarks/ci-thresholds.json");
const reportPath = resolve(root, "benchmarks/last-ci-report.json");

const ciEnv = {
  BENCH_OUTPUT: "json",
  BENCH_RING_EVENTS: process.env.BENCH_RING_EVENTS ?? "60000",
  BENCH_RECORDER_EVENTS: process.env.BENCH_RECORDER_EVENTS ?? "80000",
  BENCH_PIPELINE_EVENTS: process.env.BENCH_PIPELINE_EVENTS ?? "12000",
  BENCH_PAYLOAD_BYTES: process.env.BENCH_PAYLOAD_BYTES ?? "900",
  BENCH_SCREENSHOT_INTERVAL: process.env.BENCH_SCREENSHOT_INTERVAL ?? "120",
  BENCH_BLOB_POOL: process.env.BENCH_BLOB_POOL ?? "24",
  BENCH_BLOB_BYTES: process.env.BENCH_BLOB_BYTES ?? "24576",
  BENCH_MAX_ARCHIVE_MB: process.env.BENCH_MAX_ARCHIVE_MB ?? "100",
  BENCH_RECENT_MINUTES: process.env.BENCH_RECENT_MINUTES ?? "20"
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const thresholds = JSON.parse(await readFile(thresholdsPath, "utf8"));
  const recorder = runBenchCommand(["--filter", "@webblackbox/recorder", "bench"]);
  const pipeline = runBenchCommand(["--filter", "@webblackbox/pipeline", "bench"]);
  const checks = runChecks(recorder, pipeline, thresholds);

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        env: ciEnv,
        recorder,
        pipeline,
        checks
      },
      null,
      2
    ),
    "utf8"
  );

  const failed = checks.filter((check) => !check.ok);

  console.log(
    "Recorder ingest throughput:",
    Math.round(recorder.recorderIngest.throughputOpsPerSec)
  );
  console.log("Pipeline ingest throughput:", Math.round(pipeline.ingestThroughputOpsPerSec));
  console.log("Benchmark report:", reportPath);

  if (failed.length > 0) {
    const detail = failed.map((check) => `- ${check.name}: ${check.detail}`).join("\n");
    throw new Error(`Benchmark regression checks failed:\n${detail}`);
  }

  console.log("Benchmark regression checks passed.");
}

function runBenchCommand(args) {
  const result = spawnSync("pnpm", [...args, "--", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...ciEnv
    }
  });

  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    throw new Error(
      `Benchmark command failed: pnpm ${args.join(" ")}\n${stderr || stdout || "No output"}`
    );
  }

  const lines = (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{") && line.endsWith("}"));

  if (!jsonLine) {
    throw new Error(`Unable to parse benchmark JSON from command output: pnpm ${args.join(" ")}`);
  }

  return JSON.parse(jsonLine);
}

function runChecks(recorder, pipeline, thresholds) {
  const checks = [];

  checks.push(
    assertCheck(
      "recorder.ringOptimized.throughputOpsPerSec",
      recorder.ringOptimized.throughputOpsPerSec >= thresholds.recorder.ringOptimizedMinOpsPerSec,
      `expected >= ${thresholds.recorder.ringOptimizedMinOpsPerSec}, got ${Math.round(
        recorder.ringOptimized.throughputOpsPerSec
      )}`
    )
  );

  checks.push(
    assertCheck(
      "recorder.recorderIngest.throughputOpsPerSec",
      recorder.recorderIngest.throughputOpsPerSec >= thresholds.recorder.recorderIngestMinOpsPerSec,
      `expected >= ${thresholds.recorder.recorderIngestMinOpsPerSec}, got ${Math.round(
        recorder.recorderIngest.throughputOpsPerSec
      )}`
    )
  );

  checks.push(
    assertCheck(
      "recorder.snapshotLatencyMs",
      recorder.snapshotLatencyMs <= thresholds.recorder.snapshotLatencyMaxMs,
      `expected <= ${thresholds.recorder.snapshotLatencyMaxMs}, got ${recorder.snapshotLatencyMs.toFixed(2)}`
    )
  );

  checks.push(
    assertCheck(
      "pipeline.ingestThroughputOpsPerSec",
      pipeline.ingestThroughputOpsPerSec >= thresholds.pipeline.ingestMinOpsPerSec,
      `expected >= ${thresholds.pipeline.ingestMinOpsPerSec}, got ${Math.round(
        pipeline.ingestThroughputOpsPerSec
      )}`
    )
  );

  checks.push(
    assertCheck(
      "pipeline.fullExportDurationMs",
      pipeline.fullExportDurationMs <= thresholds.pipeline.fullExportMaxMs,
      `expected <= ${thresholds.pipeline.fullExportMaxMs}, got ${pipeline.fullExportDurationMs.toFixed(2)}`
    )
  );

  checks.push(
    assertCheck(
      "pipeline.filteredExportDurationMs",
      pipeline.filteredExportDurationMs <= thresholds.pipeline.filteredExportMaxMs,
      `expected <= ${thresholds.pipeline.filteredExportMaxMs}, got ${pipeline.filteredExportDurationMs.toFixed(
        2
      )}`
    )
  );

  checks.push(
    assertCheck(
      "pipeline.archiveDropRatio",
      pipeline.archiveDropRatio >= thresholds.pipeline.archiveDropRatioMin,
      `expected >= ${thresholds.pipeline.archiveDropRatioMin}, got ${pipeline.archiveDropRatio.toFixed(3)}`
    )
  );

  return checks;
}

function assertCheck(name, ok, detail) {
  return {
    name,
    ok,
    detail
  };
}
