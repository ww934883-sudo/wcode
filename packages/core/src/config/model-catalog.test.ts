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
      store.add("volcengine", "glm-5.3-flash", "200K");
      store.add("anthropic", "claude-sonnet-4-5");
      store.add("volcengine", "doubao-seed-2-1-pro", "1M");
      store.add("volcengine", "glm-5.3-flash"); // 重复：幂等不增不改

      expect(store.list()).toEqual([
        { provider: "anthropic", models: [{ model: "claude-sonnet-4-5" }] },
        {
          provider: "volcengine",
          models: [
            { model: "glm-5.3-flash", contextLabel: "200K" },
            { model: "doubao-seed-2-1-pro", contextLabel: "1M" },
          ],
        },
      ]);
      expect(store.list("volcengine")).toEqual([
        {
          provider: "volcengine",
          models: [
            { model: "glm-5.3-flash", contextLabel: "200K" },
            { model: "doubao-seed-2-1-pro", contextLabel: "1M" },
          ],
        },
      ]);

      store.remove("volcengine", "glm-5.3-flash");
      store.remove("volcengine", "不存在的模型"); // 幂等不抛
      expect(store.list("volcengine")).toEqual([
        { provider: "volcengine", models: [{ model: "doubao-seed-2-1-pro", contextLabel: "1M" }] },
      ]);
      // 同名 reopen（连接缓存共享）：数据仍在
      const again = await ModelCatalogStore.open(join(home, ".wcode", "wcode.db"));
      expect(again.list()).toHaveLength(2);
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("updateModel：改 id 保序、改/清标注、不存在时报错", async () => {
    const home = await mkdtemp(join(tmpdir(), "wcode-catalog-u-"));
    try {
      const store = await ModelCatalogStore.open(join(home, ".wcode", "wcode.db"));
      store.add("p", "a", "1M");
      store.add("p", "b");
      store.updateModel("p", "b", { model: "b2", contextLabel: "256K" });
      expect(store.list("p")).toEqual([
        { provider: "p", models: [{ model: "a", contextLabel: "1M" }, { model: "b2", contextLabel: "256K" }] },
      ]);
      store.updateModel("p", "b2", { contextLabel: null }); // 只清标注
      expect(store.list("p")).toEqual([
        { provider: "p", models: [{ model: "a", contextLabel: "1M" }, { model: "b2" }] },
      ]);
      expect(() => store.updateModel("p", "不存在", { model: "x" })).toThrow();
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("renameProvider / removeProvider：整组迁移与级联删除", async () => {
    const home = await mkdtemp(join(tmpdir(), "wcode-catalog-r-"));
    try {
      const store = await ModelCatalogStore.open(join(home, ".wcode", "wcode.db"));
      store.add("old", "m1");
      store.add("keep", "m2");
      store.renameProvider("old", "new");
      expect(store.list()).toEqual([
        { provider: "keep", models: [{ model: "m2" }] },
        { provider: "new", models: [{ model: "m1" }] },
      ]);
      store.removeProvider("new");
      expect(store.list("new")).toEqual([]);
      expect(store.list("keep")).toEqual([{ provider: "keep", models: [{ model: "m2" }] }]);
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
