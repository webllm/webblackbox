import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createE2eTempPath,
  executableSearchPaths,
  extensionChromeLoadArgs,
  resolveExecutable,
  terminateProcess
} from "./e2e-runtime.mjs";

test("keeps unpacked extension loading available in branded and unbranded test browsers", () => {
  assert.deepEqual(extensionChromeLoadArgs("/tmp/WebBlackbox Extension"), [
    "--disable-features=DisableDisableExtensionsExceptCommandLineSwitch",
    "--disable-extensions-except=/tmp/WebBlackbox Extension",
    "--load-extension=/tmp/WebBlackbox Extension"
  ]);
  assert.throws(() => extensionChromeLoadArgs(""), /non-empty path/u);
});

test("creates platform-native E2E temporary paths", () => {
  assert.equal(
    createE2eTempPath("webblackbox-profile", "", {
      temporaryDirectory: "/var/tmp",
      processId: 42,
      timestamp: 1_234,
      platform: "linux"
    }),
    "/var/tmp/webblackbox-profile-42-1234"
  );
  assert.equal(
    createE2eTempPath("webblackbox-log", ".log", {
      temporaryDirectory: "C:\\Temp",
      processId: 42,
      timestamp: 1_234,
      platform: "win32"
    }),
    "C:\\Temp\\webblackbox-log-42-1234.log"
  );
});

test("builds POSIX PATH candidates without invoking which", () => {
  assert.deepEqual(
    executableSearchPaths("chromium", {
      platform: "linux",
      pathValue: "/opt/chrome/bin:/usr/local/bin:/usr/bin"
    }),
    ["/opt/chrome/bin/chromium", "/usr/local/bin/chromium", "/usr/bin/chromium"]
  );
  assert.deepEqual(
    executableSearchPaths("/Applications/Chrome For Testing", {
      platform: "darwin",
      pathValue: "/unused"
    }),
    ["/Applications/Chrome For Testing"]
  );
});

test("builds Windows PATH and PATHEXT candidates", () => {
  assert.deepEqual(
    executableSearchPaths("chrome", {
      platform: "win32",
      pathValue: '"C:\\Program Files\\Chrome";D:\\Tools',
      pathExtValue: ".EXE;.CMD"
    }),
    [
      "C:\\Program Files\\Chrome\\chrome.EXE",
      "C:\\Program Files\\Chrome\\chrome.CMD",
      "D:\\Tools\\chrome.EXE",
      "D:\\Tools\\chrome.CMD"
    ]
  );
  assert.deepEqual(
    executableSearchPaths("chrome.exe", {
      platform: "win32",
      pathValue: "C:\\Chrome;D:\\Tools",
      pathExtValue: ".EXE;.CMD"
    }),
    ["C:\\Chrome\\chrome.exe", "D:\\Tools\\chrome.exe"]
  );
  assert.deepEqual(
    executableSearchPaths('"C:\\Program Files\\Chrome\\chrome.exe"', {
      platform: "win32",
      pathValue: "C:\\Unused"
    }),
    ["C:\\Program Files\\Chrome\\chrome.exe"]
  );
});

test("resolves explicit paths and PATH commands with injected access checks", async () => {
  const explicitChecks = [];
  const explicit = await resolveExecutable("./fixtures/chrome", {
    platform: "linux",
    pathValue: "/unused",
    async accessImplementation(path) {
      explicitChecks.push(path);
    }
  });
  assert.equal(explicit, "./fixtures/chrome");
  assert.deepEqual(explicitChecks, ["./fixtures/chrome"]);

  const pathChecks = [];
  const fromPath = await resolveExecutable("chrome", {
    platform: "win32",
    pathValue: "C:\\Missing;D:\\Chrome",
    pathExtValue: ".EXE",
    async accessImplementation(path) {
      pathChecks.push(path);
      if (path !== "D:\\Chrome\\chrome.EXE") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
    }
  });
  assert.equal(fromPath, "D:\\Chrome\\chrome.EXE");
  assert.deepEqual(pathChecks, ["C:\\Missing\\chrome.EXE", "D:\\Chrome\\chrome.EXE"]);
});

test("force kills a child that ignores SIGTERM even after killed becomes true", async () => {
  const processHandle = new EventEmitter();
  const signals = [];
  processHandle.exitCode = null;
  processHandle.signalCode = null;
  processHandle.killed = false;
  processHandle.kill = (signal) => {
    signals.push(signal);
    processHandle.killed = true;

    if (signal === "SIGKILL") {
      processHandle.signalCode = signal;
      queueMicrotask(() => processHandle.emit("exit", null, signal));
    }

    return true;
  };

  await terminateProcess(processHandle, { graceMs: 1, forceKillWaitMs: 10 });

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});
