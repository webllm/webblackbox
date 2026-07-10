export function parseExtensionBuildArgs(args) {
  const knownFlags = new Set(["--package", "--profile", "--release", "--output", "--output-dir"]);
  const packageArchive = args.includes("--package");
  const outputDir = readFlagValue(args, "--output-dir");
  const outputPath = readFlagValue(args, "--output");
  const requestedProfile = readFlagValue(args, "--profile");

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (
      arg.startsWith("--output=") ||
      arg.startsWith("--output-dir=") ||
      arg.startsWith("--profile=")
    ) {
      continue;
    }

    if (!knownFlags.has(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    if (
      (arg === "--output" || arg === "--output-dir" || arg === "--profile") &&
      !args[index + 1]?.startsWith("--")
    ) {
      index += 1;
    }
  }

  return {
    // Packaging is a release operation by default. Development builds retain
    // their stable key unless callers explicitly request --release.
    release: packageArchive || args.includes("--release"),
    packageArchive,
    // The safe profile is the only implicit packaging profile. Producing an
    // enterprise archive requires an explicit --profile dev opt-in.
    profile: requestedProfile ?? (packageArchive ? "store-safe" : "dev"),
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
