import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiKey = "share-test-key";

type RunningShareServer = {
  baseUrl: string;
  child: ChildProcess;
  dataDir: string;
  logs: string[];
};

let runningServers: RunningShareServer[] = [];

afterEach(async () => {
  await Promise.all(runningServers.map((server) => stopShareServer(server)));
  runningServers = [];
});

describe("share-server", () => {
  it("returns 413 when an upload exceeds the configured size limit", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_MAX_UPLOAD_BYTES: "4"
    });

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "too-large.webblackbox"
      },
      body: Buffer.from("12345")
    });

    await expect(response.json()).resolves.toEqual({
      error: "Upload payload exceeds 4 bytes."
    });
    expect(response.status).toBe(413);
  });
});

async function startShareServer(
  envOverrides: Record<string, string> = {}
): Promise<RunningShareServer> {
  const port = await reservePort();
  const dataDir = await mkdtemp(resolve(tmpdir(), "webblackbox-share-test-"));
  const child = spawn(process.execPath, [tsxCli, resolve(appRoot, "src/index.ts")], {
    cwd: appRoot,
    env: {
      ...process.env,
      PORT: String(port),
      WEBBLACKBOX_SHARE_API_KEY: apiKey,
      WEBBLACKBOX_SHARE_BIND_HOST: "127.0.0.1",
      WEBBLACKBOX_SHARE_DATA_DIR: dataDir,
      ...envOverrides
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const server: RunningShareServer = {
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    dataDir,
    logs: []
  };

  child.stdout?.on("data", (chunk) => {
    server.logs.push(String(chunk));
  });
  child.stderr?.on("data", (chunk) => {
    server.logs.push(String(chunk));
  });
  runningServers.push(server);

  await waitForShareServer(server);
  return server;
}

async function stopShareServer(server: RunningShareServer): Promise<void> {
  if (server.child.exitCode === null && !server.child.killed) {
    server.child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      server.child.once("exit", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }

  await rm(server.dataDir, {
    recursive: true,
    force: true
  });
}

async function waitForShareServer(server: RunningShareServer): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(
        `share-server exited early with ${server.child.exitCode}: ${server.logs.join("")}`
      );
    }

    try {
      const response = await fetch(
        `${server.baseUrl}/api/share/list?key=${encodeURIComponent(apiKey)}`
      );

      if (response.ok) {
        return;
      }
    } catch {
      // retry until the process binds the port
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`share-server did not become ready: ${server.logs.join("")}`);
}

async function reservePort(): Promise<number> {
  const server = createServer();

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve a local TCP port.");
  }

  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolvePromise();
    });
  });

  return address.port;
}
