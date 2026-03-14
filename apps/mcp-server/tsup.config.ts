import { readFileSync } from "node:fs";

import { defineConfig } from "tsup";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const serverVersion =
  typeof packageJson.version === "string" && packageJson.version.length > 0
    ? packageJson.version
    : "0.0.0";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts"
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: true,
  sourcemap: true,
  clean: false,
  define: {
    __MCP_SERVER_VERSION__: JSON.stringify(serverVersion)
  }
});
