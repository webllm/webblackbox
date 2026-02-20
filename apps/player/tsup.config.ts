import { defineConfig } from "tsup";

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
  clean: true,
  splitting: false,
  dts: false,
  esbuildOptions(options) {
    options.external = [];
  }
});
