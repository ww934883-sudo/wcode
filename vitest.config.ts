import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
    // 覆盖率阈值在 CI 中逐步收紧，本地先保证全绿
  },
});
