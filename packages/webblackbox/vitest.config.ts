import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@webblackbox/pipeline": resolve(root, "../pipeline/src/index.ts"),
      "@webblackbox/protocol": resolve(root, "../protocol/src/index.ts"),
      "@webblackbox/recorder": resolve(root, "../recorder/src/index.ts")
    }
  },
  test: {
    environment: "node"
  }
});
