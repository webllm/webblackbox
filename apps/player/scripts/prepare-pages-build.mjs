import { access, copyFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, "..");
const buildDir = resolve(appRoot, "build");
const indexPath = resolve(buildDir, "index.html");
const notFoundPath = resolve(buildDir, "404.html");
const noJekyllPath = resolve(buildDir, ".nojekyll");

await access(indexPath, constants.R_OK);
await stat(buildDir);

await copyFile(indexPath, notFoundPath);
await writeFile(noJekyllPath, "", "utf8");

console.info(
  JSON.stringify(
    {
      ok: true,
      buildDir,
      pages: {
        index: indexPath,
        notFound: notFoundPath,
        noJekyll: noJekyllPath
      }
    },
    null,
    2
  )
);
