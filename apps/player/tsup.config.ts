import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const playerVersion =
  typeof packageJson.version === "string" && packageJson.version.length > 0
    ? packageJson.version
    : "0.0.0";

export default defineConfig({
  entry: {
    main: "src/main.ts"
  },
  format: ["esm"],
  target: "es2022",
  platform: "browser",
  bundle: true,
  skipNodeModulesBundle: false,
  noExternal: [/.*/],
  sourcemap: true,
  outDir: "build",
  clean: false,
  splitting: false,
  dts: false,
  define: {
    __PLAYER_VERSION__: JSON.stringify(playerVersion)
  },
  esbuildOptions(options) {
    options.external = [];
  }
});
