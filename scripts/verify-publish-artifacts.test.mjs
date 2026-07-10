import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLIC_PACKAGE_DEFINITIONS,
  PUBLIC_PACKAGE_NAMES,
  assertCompletePackageSet,
  assertNoWorkspaceSpecifiers,
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
