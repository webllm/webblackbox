import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@webblackbox/mcp-core": fileURLToPath(
        new URL("../../packages/mcp-core/src/index.ts", import.meta.url)
      ),
      "@webblackbox/player-sdk": fileURLToPath(
        new URL("../../packages/player-sdk/src/index.ts", import.meta.url)
      ),
      "@webblackbox/protocol": fileURLToPath(
        new URL("../../packages/protocol/src/index.ts", import.meta.url)
      )
    }
  }
});
