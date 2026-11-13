import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@ainb/protocol": new URL("../protocol/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1") } },
  test: { testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false },
});
