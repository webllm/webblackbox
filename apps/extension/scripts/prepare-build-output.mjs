import { resolve } from "node:path";

import { buildDir, hasFlag, prepareBuildOutput, readFlagValue } from "./lib/extension-build.mjs";

const args = process.argv.slice(2);
const release = hasFlag(args, "--release");
const outputArg = readFlagValue(args, "--output-dir");
const outputDir = outputArg ? resolve(process.cwd(), outputArg) : buildDir;

const manifest = await prepareBuildOutput({
  outputDir,
  release
});

console.info(
  JSON.stringify(
    {
      ok: true,
      outputDir,
      release,
      manifest: {
        version: manifest.version,
        hasKey: Object.hasOwn(manifest, "key"),
        csp: manifest.content_security_policy?.extension_pages ?? null
      }
    },
    null,
    2
  )
);
