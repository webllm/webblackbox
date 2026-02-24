import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { listArchives } from "./session-tools.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, {
        recursive: true,
        force: true
      })
    )
  );
});

describe("session tools", () => {
  it("lists archive files and ignores non-archive files", async () => {
    const root = await mkdtemp(join(tmpdir(), "wb-mcp-list-"));
    tempDirs.push(root);

    await writeFile(join(root, "a.webblackbox"), "alpha");
    await writeFile(join(root, "b.zip"), "bravo");
    await writeFile(join(root, "ignore.txt"), "ignore");

    const result = await listArchives({
      dir: root,
      recursive: false,
      limit: 10
    });

    expect(result.count).toBe(2);
    expect(result.archives.map((row) => row.path)).toEqual(
      expect.arrayContaining([join(root, "a.webblackbox"), join(root, "b.zip")])
    );
  });

  it("supports recursive scan and result limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "wb-mcp-recursive-"));
    tempDirs.push(root);

    await mkdir(join(root, "nested"), {
      recursive: true
    });
    await writeFile(join(root, "base.webblackbox"), "base");
    await writeFile(join(root, "nested", "child.webblackbox"), "child");

    const shallow = await listArchives({
      dir: root,
      recursive: false,
      limit: 10
    });
    expect(shallow.count).toBe(1);

    const recursive = await listArchives({
      dir: root,
      recursive: true,
      limit: 1
    });
    expect(recursive.count).toBe(1);
  });
});
