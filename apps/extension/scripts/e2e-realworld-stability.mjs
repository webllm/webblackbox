#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const fullchainScript = resolve(root, "e2e-fullchain-demo.mjs");

const quick = (process.env.WB_E2E_REALWORLD_QUICK ?? "0") === "1";
const headless = (process.env.WB_E2E_HEADLESS ?? "1") !== "0";
const basePort = Number(process.env.WB_E2E_REALWORLD_BASE_PORT ?? "9250");

const scenarios = [
  {
    name: "lite-spa-reload-runtime",
    mode: "lite",
    description:
      "Lite runtime-message path with SPA-style in-page interactions and post-start reload recovery.",
    env: {
      WB_E2E_MODE: "lite",
      WB_E2E_RELOAD_AFTER_START: "1",
      WB_E2E_USE_POPUP_UI: "0",
      WB_E2E_REALWORLD_SCENARIO: "spa-multitab-permission-restart-long"
    }
  },
  {
    name: "lite-download-upload-large-response",
    mode: "lite",
    description: headless
      ? "Lite runtime path preserving upload/download/export and response-body hover checks in headless Chrome."
      : "Lite popup path preserving upload/download/export and response-body hover checks.",
    env: {
      WB_E2E_MODE: "lite",
      WB_E2E_RELOAD_AFTER_START: "0",
      WB_E2E_USE_POPUP_UI: headless ? "0" : "1",
      WB_E2E_REALWORLD_SCENARIO: "upload-download-large-response"
    }
  },
  {
    name: "full-cdp-iframe-multitarget",
    mode: "full",
    description:
      "Full CDP path exercising iframe/child-target capture, network bodies, screenshots, and player replay.",
    env: {
      WB_E2E_MODE: "full",
      WB_E2E_RELOAD_AFTER_START: "0",
      WB_E2E_USE_POPUP_UI: "0",
      WB_E2E_REALWORLD_SCENARIO: "iframe-cdp-multitarget"
    }
  }
];

const selected = quick ? scenarios.slice(0, 1) : scenarios;

main().catch((error) => {
  console.error(
    "Real-world stability E2E failed:",
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});

async function main() {
  console.log(`Real-world stability matrix: ${selected.length}/${scenarios.length} scenario(s)`);

  for (let index = 0; index < selected.length; index += 1) {
    const scenario = selected[index];
    await runScenario(scenario, index);
  }

  console.log("Real-world stability E2E matrix passed.");
}

function runScenario(scenario, index) {
  return new Promise((resolvePromise, rejectPromise) => {
    const env = {
      ...process.env,
      ...scenario.env,
      WB_E2E_REMOTE_PORT: String(basePort + index),
      WB_E2E_LOG:
        process.env.WB_E2E_LOG ?? `/tmp/webblackbox-realworld-${scenario.name}-${Date.now()}.log`,
      WB_E2E_PROFILE_DIR:
        process.env.WB_E2E_PROFILE_DIR ??
        `/tmp/webblackbox-realworld-profile-${scenario.name}-${Date.now()}`,
      WB_E2E_DOWNLOAD_DIR:
        process.env.WB_E2E_DOWNLOAD_DIR ??
        `/tmp/webblackbox-realworld-downloads-${scenario.name}-${Date.now()}`
    };

    console.log(`\n[realworld:${index + 1}/${selected.length}] ${scenario.name}`);
    console.log(scenario.description);

    const child = spawn(process.execPath, [fullchainScript], {
      env,
      stdio: "inherit"
    });

    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(
        new Error(
          `Scenario ${scenario.name} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`
        )
      );
    });
  });
}
