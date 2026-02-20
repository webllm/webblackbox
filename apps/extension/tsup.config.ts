import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    sw: "src/sw/index.ts",
    content: "src/content/index.ts",
    offscreen: "src/offscreen/index.ts",
    popup: "src/popup/index.ts",
    options: "src/options/index.ts",
    sessions: "src/sessions/index.ts",
    injected: "src/injected/index.ts"
  },
  format: ["esm"],
  target: "es2022",
  platform: "browser",
  bundle: true,
  skipNodeModulesBundle: false,
  noExternal: [/.*/],
  sourcemap: true,
  outDir: "build",
  clean: true,
  splitting: false,
  dts: false,
  esbuildOptions(options) {
    options.external = [];
  }
});
