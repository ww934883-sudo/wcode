import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelCatalogStore } from "./model-catalog";

describe("ModelCatalogStore（provider_models 表）", () => {
  it("增删与分组排序：组间名称序、组内添加序、重复添加幂等", async () => {
    const home = await mkdtemp(join(tmpdir(), "wcode-catalog-"));
    try {
      const store = await ModelCatalogStore.open(join(home, ".wcode", "wcode.db"));
      store.add("volcengine", "glm-5.3-flash");
      store.add("anthropic", "claude-sonnet-4-5");
      store.add("volcengine", "doubao-seed-2-1-pro");
      store.add("volcengine", "glm-5.3-flash"); // 重复：幂等

      expect(store.list()).toEqual([
        { provider: "anthropic", models: ["claude-sonnet-4-5"] },
        { provider: "volcengine", models: ["glm-5.3-flash", "doubao-seed-2-1-pro"] },
      ]);
      // 单组查询
      expect(store.list("volcengine")).toEqual([
        { provider: "volcengine", models: ["glm-5.3-flash", "doubao-seed-2-1-pro"] },
      ]);

      store.remove("volcengine", "glm-5.3-flash");
      store.remove("volcengine", "不存在的模型"); // 幂等不抛
      expect(store.list("volcengine")).toEqual([
        { provider: "volcengine", models: ["doubao-seed-2-1-pro"] },
      ]);
      // 同名 reopen（连接缓存共享）：数据仍在
      const again = await ModelCatalogStore.open(join(home, ".wcode", "wcode.db"));
      expect(again.list()).toHaveLength(2);
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("空串与纯空白拒绝", async () => {
    const home = await mkdtemp(join(tmpdir(), "wcode-catalog-e-"));
    try {
      const store = await ModelCatalogStore.open(join(home, ".wcode", "wcode.db"));
      expect(() => store.add("volcengine", "  ")).toThrow();
      expect(() => store.add("", "m")).toThrow();
      expect(store.list()).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });
});
