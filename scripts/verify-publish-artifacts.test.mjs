import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLIC_PACKAGE_DEFINITIONS,
  PUBLIC_PACKAGE_NAMES,
  assertCompletePackageSet,
  assertNoWorkspaceSpecifiers,
  createCommandRunner,
  getPublicExportSpecifiers,
  validatePackedManifest
} from "./verify-publish-artifacts.mjs";

test("rejects workspace specifiers recursively anywhere in a packed manifest", () => {
  assert.throws(
    () =>
      assertNoWorkspaceSpecifiers({
        name: "example",
        dependencies: {
          nested: {
            resolutions: ["1.0.0", { protocol: "workspace:^" }]
          }
        }
      }),
    /\$\.dependencies\.nested\.resolutions\[1\]\.protocol/
  );

  assert.doesNotThrow(() =>
    assertNoWorkspaceSpecifiers({
      dependencies: {
        "@webblackbox/protocol": "0.6.0"
      },
      files: ["dist"]
    })
  );
});

test("requires the complete public package set exactly once", () => {
  const complete = PUBLIC_PACKAGE_NAMES.map((name) => ({ name }));
  assert.doesNotThrow(() => assertCompletePackageSet(complete));
  assert.throws(
    () => assertCompletePackageSet(complete.slice(1)),
    /missing: @webblackbox\/protocol/
  );
  assert.throws(
    () => assertCompletePackageSet([...complete, { name: PUBLIC_PACKAGE_NAMES[0] }]),
    /duplicates: @webblackbox\/protocol \(2\)/
  );
  assert.throws(
    () => assertCompletePackageSet([...complete, { name: "unexpected-package" }]),
    /unexpected: unexpected-package/
  );
});

test("validates declared files and MCP bin targets against tar contents", () => {
  const expectedPackage = PUBLIC_PACKAGE_DEFINITIONS.find(
    ({ name }) => name === "@webblackbox/mcp-server"
  );
  const manifest = {
    name: "@webblackbox/mcp-server",
    version: "0.6.0",
    files: ["dist", "README.md"],
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js"
      }
    },
    bin: {
      "webblackbox-mcp-server": "./dist/cli.js"
    },
    dependencies: {
      "@webblackbox/player-sdk": "0.6.0"
    }
  };
  const entries = [
    "package/package.json",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/cli.js",
    "package/README.md"
  ];

  assert.doesNotThrow(() => validatePackedManifest({ manifest, entries, expectedPackage }));
  assert.throws(
    () =>
      validatePackedManifest({
        manifest: {
          ...manifest,
          bin: { "webblackbox-mcp-server": "../outside.js" }
        },
        entries,
        expectedPackage
      }),
    /bin .* does not match/
  );
  assert.throws(
    () =>
      validatePackedManifest({
        manifest: {
          ...manifest,
          exports: {
            ...manifest.exports,
            "./missing": {
              import: "./dist/missing.js"
            }
          }
        },
        entries,
        expectedPackage
      }),
    /exports\.\.\/missing\.import target dist\/missing\.js is missing/
  );
  assert.throws(
    () =>
      validatePackedManifest({
        manifest: { ...manifest, main: "./dist/missing.js" },
        entries,
        expectedPackage
      }),
    /main target dist\/missing\.js is missing/
  );
  assert.throws(
    () =>
      validatePackedManifest({
        manifest: { ...manifest, types: "./dist/missing.d.ts" },
        entries,
        expectedPackage
      }),
    /types target dist\/missing\.d\.ts is missing/
  );
});

test("derives every public package export subpath for import smoke tests", () => {
  assert.deepEqual(
    getPublicExportSpecifiers({
      name: "webblackbox",
      exports: {
        ".": "./dist/index.js",
        "./injected-hooks": {
          types: "./dist/injected-hooks.d.ts",
          import: "./dist/injected-hooks.js"
        },
        "./lite-sdk": "./dist/lite-sdk.js"
      }
    }),
    ["webblackbox", "webblackbox/injected-hooks", "webblackbox/lite-sdk"]
  );
});

test("launches Windows package command shims through a safely quoted cmd adapter", async () => {
  const calls = [];
  const commandInterpreter = "C:\\Windows\\System32\\cmd.exe";
  const runCommand = createCommandRunner({
    platform: "win32",
    commandInterpreter,
    execFileRunner: async (command, arguments_, options) => {
      calls.push({ command, arguments_, options });
      return { stdout: "ok\n", stderr: "" };
    }
  });

  await runCommand(
    "C:\\Program Files\\pnpm\\pnpm.cmd",
    ["pack", "--pack-destination", "C:\\Temp Folder\\tarballs"],
    { cwd: "C:\\Repo With Spaces" }
  );
  await runCommand(
    "npm.cmd",
    ["install", "--package-lock=false", "C:\\Temp Folder\\package.tgz"],
    {}
  );
  await runCommand(
    "C:\\Temp Folder\\node_modules\\.bin\\webblackbox-mcp-server.cmd",
    ["--version"],
    {}
  );

  assert.deepEqual(
    calls.map(({ command, arguments_ }) => ({ command, arguments_ })),
    [
      {
        command: commandInterpreter,
        arguments_: [
          "/d",
          "/s",
          "/v:off",
          "/c",
          '""C:\\Program Files\\pnpm\\pnpm.cmd" "pack" "--pack-destination" "C:\\Temp Folder\\tarballs""'
        ]
      },
      {
        command: commandInterpreter,
        arguments_: [
          "/d",
          "/s",
          "/v:off",
          "/c",
          '""npm.cmd" "install" "--package-lock=false" "C:\\Temp Folder\\package.tgz""'
        ]
      },
      {
        command: commandInterpreter,
        arguments_: [
          "/d",
          "/s",
          "/v:off",
          "/c",
          '""C:\\Temp Folder\\node_modules\\.bin\\webblackbox-mcp-server.cmd" "--version""'
        ]
      }
    ]
  );
  assert.equal(calls[0].options.cwd, "C:\\Repo With Spaces");
  assert.ok(calls.every(({ options }) => options.windowsVerbatimArguments === true));
});

test("keeps non-Windows commands on the direct execFile path", async () => {
  const calls = [];
  const runCommand = createCommandRunner({
    platform: "linux",
    execFileRunner: async (command, arguments_, options) => {
      calls.push({ command, arguments_, options });
      return { stdout: "", stderr: "" };
    }
  });

  await runCommand("pnpm", ["pack", "--pack-destination", "/tmp/path with spaces"]);

  assert.equal(calls[0].command, "pnpm");
  assert.deepEqual(calls[0].arguments_, ["pack", "--pack-destination", "/tmp/path with spaces"]);
  assert.equal(calls[0].options.windowsVerbatimArguments, undefined);
});

test("rejects Windows shim tokens that could escape cmd quoting or expand variables", async () => {
  let calls = 0;
  const runCommand = createCommandRunner({
    platform: "win32",
    execFileRunner: async () => {
      calls += 1;
      return { stdout: "", stderr: "" };
    }
  });
  const unsafeTokens = [
    "line\rbreak",
    "line\nbreak",
    "nul\0byte",
    "%TEMP%",
    "!TEMP!",
    "$(whoami)",
    'quote"break',
    "value&whoami",
    "value|whoami",
    "value<input",
    "value>output",
    "value^escape",
    "value(parenthesized)"
  ];

  for (const unsafeToken of unsafeTokens) {
    await assert.rejects(
      runCommand("pnpm.cmd", [unsafeToken]),
      /Unsafe Windows command shim token/
    );
  }
  await assert.rejects(
    runCommand("C:\\Unsafe&Path\\pnpm.cmd", ["pack"]),
    /Unsafe Windows command shim token/
  );
  assert.equal(calls, 0);
});
