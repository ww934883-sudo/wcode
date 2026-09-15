import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
    // 用例大量 spawn 子进程（bash/hooks/node -e），线程数超过核数会因
    // CPU 争用产生超时类抖动；限制并发换取稳定性
    poolOptions: {
      threads: { maxThreads: 4, minThreads: 1 },
    },
    // 覆盖率阈值在 CI 中逐步收紧，本地先保证全绿
  },
});
