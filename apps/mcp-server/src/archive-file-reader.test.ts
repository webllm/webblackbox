import { appendFile, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readFileHandleBounded } from "./archive-file-reader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("bounded archive file reader", () => {
  it("detects growth on the same inode without allocating the appended bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "wb-mcp-fd-grow-"));
    tempDirs.push(root);
    const path = join(root, "archive.webblackbox");
    await writeFile(path, "1234");
    const handle = await open(path, "r");

    try {
      const before = await handle.stat();
      await appendFile(path, "5".repeat(1024 * 1024));
      await expect(readFileHandleBounded(handle, before.size, 2 * 1024 * 1024)).rejects.toThrow(
        /size changed while being read/i
      );
    } finally {
      await handle.close();
    }
  });

  it("keeps reading the opened inode when the pathname is replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "wb-mcp-fd-swap-"));
    tempDirs.push(root);
    const path = join(root, "archive.webblackbox");
    const originalPath = join(root, "original.webblackbox");
    await writeFile(path, "safe");
    const handle = await open(path, "r");

    try {
      const before = await handle.stat();
      await rename(path, originalPath);
      await writeFile(path, "attacker replacement");
      const bytes = await readFileHandleBounded(handle, before.size, before.size);
      expect(bytes.toString("utf8")).toBe("safe");
    } finally {
      await handle.close();
    }
  });
});
