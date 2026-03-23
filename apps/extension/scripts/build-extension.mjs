import { resolve } from "node:path";

import { buildDir, createChromeArchive, prepareBuildOutput } from "./lib/extension-build.mjs";

const options = parseArgs(process.argv.slice(2));
const outputDir = options.outputDir ? resolve(process.cwd(), options.outputDir) : buildDir;

const manifest = await prepareBuildOutput({
  outputDir,
  release: options.release
});

const result = {
  ok: true,
  outputDir,
  release: options.release,
  manifest: {
    version: manifest.version,
    hasKey: Object.hasOwn(manifest, "key"),
    csp: manifest.content_security_policy?.extension_pages ?? null
  }
};

if (options.packageArchive) {
  result.archive = await createChromeArchive({
    sourceDir: outputDir,
    outputPath: options.outputPath
  });
}

console.info(JSON.stringify(result, null, 2));

function parseArgs(args) {
  const knownFlags = new Set(["--package", "--release", "--output", "--output-dir"]);
  const release = args.includes("--release");
  const packageArchive = args.includes("--package");
  const outputDir = readFlagValue(args, "--output-dir");
  const outputPath = readFlagValue(args, "--output");

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg.startsWith("--output=") || arg.startsWith("--output-dir=")) {
      continue;
    }

    if (!knownFlags.has(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    if ((arg === "--output" || arg === "--output-dir") && !args[index + 1]?.startsWith("--")) {
      index += 1;
    }
  }

  return {
    release,
    packageArchive,
    outputDir,
    outputPath
  };
}

function readFlagValue(args, flagName) {
  const inline = args.find((entry) => entry.startsWith(`${flagName}=`));

  if (inline) {
    return inline.slice(flagName.length + 1);
  }

  const index = args.indexOf(flagName);

  if (index === -1) {
    return null;
  }

  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : null;
}
