import { copyFile, mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, "..");
const workspaceRoot = resolve(appRoot, "..", "..");
const buildDir = resolve(appRoot, "build");

const args = process.argv.slice(2);
const remoteName = readFlagValue(args, "--remote") ?? "origin";
const branchName = readFlagValue(args, "--branch") ?? "gh-pages";
const siteUrl = readFlagValue(args, "--site-url") ?? "https://webllm.github.io/webblackbox/";
const skipBuild = args.includes("--skip-build");
const skipVerify = args.includes("--skip-verify");
const commitMessage =
  readFlagValue(args, "--message") ?? `Deploy player to ${branchName}${await resolveHeadSuffix()}`;

if (!skipBuild) {
  await runCommand("pnpm", ["--filter", "@webblackbox/player", "pages:build"], workspaceRoot);
}

await stat(buildDir);

const remoteUrl = (
  await runCommand("git", ["remote", "get-url", remoteName], workspaceRoot, {
    captureStdout: true
  })
).trim();

if (!remoteUrl) {
  throw new Error(`Git remote '${remoteName}' is not configured.`);
}

const branchExists =
  (
    await runCommand("git", ["ls-remote", "--heads", remoteName, branchName], workspaceRoot, {
      captureStdout: true
    })
  ).trim().length > 0;

const tempRoot = await mkdtemp(join(tmpdir(), "webblackbox-player-pages-"));
const repoDir = resolve(tempRoot, "repo");

await mkdir(repoDir, { recursive: true });

try {
  await runCommand("git", ["init"], repoDir);
  await runCommand("git", ["remote", "add", "origin", remoteUrl], repoDir);
  await configureGitHubAuth(repoDir, remoteUrl);

  const userName = await readGitConfig("user.name", workspaceRoot);
  const userEmail = await readGitConfig("user.email", workspaceRoot);

  await runCommand("git", ["config", "user.name", userName ?? "Codex"], repoDir);
  await runCommand(
    "git",
    ["config", "user.email", userEmail ?? "codex@users.noreply.github.com"],
    repoDir
  );

  if (branchExists) {
    await runCommand("git", ["fetch", "--depth", "1", "origin", branchName], repoDir);
    await runCommand("git", ["checkout", "-B", branchName, "FETCH_HEAD"], repoDir);
  } else {
    await runCommand("git", ["checkout", "--orphan", branchName], repoDir);
  }

  await clearDirectoryExceptGit(repoDir);
  await copyDirectory(buildDir, repoDir);
  await writeFile(resolve(repoDir, ".nojekyll"), "", "utf8");

  await runCommand("git", ["add", "-A"], repoDir);

  const status = await runCommand("git", ["status", "--short"], repoDir, {
    captureStdout: true
  });

  if (status.trim().length === 0) {
    console.info(
      JSON.stringify(
        {
          ok: true,
          changed: false,
          remote: remoteName,
          branch: branchName,
          siteUrl
        },
        null,
        2
      )
    );
  } else {
    await runCommand("git", ["commit", "-m", commitMessage], repoDir);
    await runCommand("git", ["push", "origin", `${branchName}:${branchName}`], repoDir);
  }

  if (!skipVerify) {
    await waitForSite(siteUrl, 180_000);
  }

  console.info(
    JSON.stringify(
      {
        ok: true,
        changed: status.trim().length > 0,
        remote: remoteName,
        branch: branchName,
        siteUrl,
        verified: !skipVerify
      },
      null,
      2
    )
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function resolveHeadSuffix() {
  const shortSha = (
    await runCommand("git", ["rev-parse", "--short", "HEAD"], workspaceRoot, {
      captureStdout: true
    })
  ).trim();
  const dirty =
    (
      await runCommand("git", ["status", "--short"], workspaceRoot, {
        captureStdout: true
      })
    ).trim().length > 0;

  if (!shortSha) {
    return dirty ? " from dirty-worktree" : "";
  }

  return dirty ? ` from ${shortSha}-dirty` : ` from ${shortSha}`;
}

async function clearDirectoryExceptGit(directory) {
  const entries = await readdir(directory, {
    withFileTypes: true
  });

  for (const entry of entries) {
    if (entry.name === ".git") {
      continue;
    }

    await rm(resolve(directory, entry.name), {
      recursive: true,
      force: true
    });
  }
}

async function copyDirectory(sourceDir, targetDir) {
  const entries = await readdir(sourceDir, {
    withFileTypes: true
  });

  for (const entry of entries) {
    const sourcePath = resolve(sourceDir, entry.name);
    const targetPath = resolve(targetDir, entry.name);

    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await copyDirectory(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile()) {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    }
  }
}

async function readGitConfig(key, cwd) {
  try {
    const value = await runCommand("git", ["config", key], cwd, {
      captureStdout: true
    });
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function configureGitHubAuth(cwd, remoteUrl) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";

  if (!token) {
    return;
  }

  const normalizedRemote = normalizeGitHubHttpsRemote(remoteUrl);

  if (!normalizedRemote) {
    return;
  }

  const extraHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  await runCommand(
    "git",
    ["config", "--local", `http.${normalizedRemote.origin}/.extraheader`, extraHeader],
    cwd
  );
}

function normalizeGitHubHttpsRemote(remoteUrl) {
  if (typeof remoteUrl !== "string" || remoteUrl.length === 0) {
    return null;
  }

  if (remoteUrl.startsWith("git@github.com:")) {
    return {
      origin: "https://github.com"
    };
  }

  try {
    const parsed = new URL(remoteUrl);

    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
      return null;
    }

    return {
      origin: parsed.origin
    };
  } catch {
    return null;
  }
}

async function waitForSite(url, timeoutMs) {
  const startedAt = Date.now();
  let lastStatus = "unknown";

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: {
          "cache-control": "no-cache"
        }
      });
      const body = await response.text();
      lastStatus = `${response.status}`;

      if (response.ok && body.includes("<title>WebBlackbox Player</title>")) {
        return;
      }
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }

    await sleep(5_000);
  }

  throw new Error(`Timed out waiting for ${url} to serve the player. Last status: ${lastStatus}`);
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function readFlagValue(argv, flagName) {
  const inline = argv.find((entry) => entry.startsWith(`${flagName}=`));

  if (inline) {
    return inline.slice(flagName.length + 1);
  }

  const index = argv.indexOf(flagName);

  if (index === -1) {
    return null;
  }

  return argv[index + 1] ?? null;
}

function runCommand(command, args, cwd, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const child = spawn(command, args, {
      cwd,
      stdio: options.captureStdout ? ["ignore", "pipe", "pipe"] : "inherit"
    });

    if (options.captureStdout) {
      child.stdout?.on("data", (chunk) => {
        stdoutChunks.push(Buffer.from(chunk));
      });
      child.stderr?.on("data", (chunk) => {
        stderrChunks.push(Buffer.from(chunk));
      });
    }

    child.on("error", (error) => {
      rejectPromise(
        new Error(
          `Failed to launch '${command}'. Make sure it is installed and available in PATH. ${error.message}`
        )
      );
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdoutChunks).toString("utf8"));
        return;
      }

      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      rejectPromise(
        new Error(
          stderr.length > 0
            ? `'${command}' exited with code ${code ?? "unknown"}: ${stderr}`
            : `'${command}' exited with code ${code ?? "unknown"}.`
        )
      );
    });
  });
}
