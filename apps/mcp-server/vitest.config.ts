import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@webblackbox/player-sdk": fileURLToPath(
        new URL("../../packages/player-sdk/src/index.ts", import.meta.url)
      ),
      "@webblackbox/protocol": fileURLToPath(
        new URL("../../packages/protocol/src/index.ts", import.meta.url)
      )
    }
  },
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
      thresholds: {
        lines: 65,
        statements: 65,
        functions: 55,
        branches: 45
      }
    }
  }
});
