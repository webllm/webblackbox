import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(root, "..");
const sourceDir = resolve(appRoot, "public");
const outputDir = resolve(appRoot, "build");

await mkdir(outputDir, { recursive: true });
await cp(sourceDir, outputDir, { recursive: true });
