import type { Logger } from "../logging/port";
import { openSqliteDb } from "../session/sqlite-store";

/** 按供应商分组的模型目录条目（provider 组内保持添加序） */
export interface ModelCatalogGroup {
  provider: string;
  models: string[];
}

/**
 * 供应商模型目录（SQLite provider_models 表，迁移 0003）：
 * 模型选择器按供应商分组展示「配置的模型」。连接信息与密钥仍在
 * settings.json（接缝五），清单高频变动走 db——两者分属低频/高频写路径。
 */
export class ModelCatalogStore {
  private constructor(private readonly db: Awaited<ReturnType<typeof openSqliteDb>>) {}

  static async open(dbPath: string, log?: Logger): Promise<ModelCatalogStore> {
    return new ModelCatalogStore(await openSqliteDb(dbPath, log));
  }

  /** 全量目录；指定 provider 只取该组。组间按名称序，组内按添加序 */
  list(provider?: string): ModelCatalogGroup[] {
    const rows = (
      provider
        ? this.db
            .prepare(
              "SELECT provider, model FROM provider_models WHERE provider = ? ORDER BY sort, created_at",
            )
            .all(provider)
        : this.db
            .prepare(
              "SELECT provider, model FROM provider_models ORDER BY provider, sort, created_at",
            )
            .all()
    ) as { provider: string; model: string }[];
    const groups = new Map<string, string[]>();
    for (const r of rows) {
      const list = groups.get(r.provider);
      if (list) list.push(r.model);
      else groups.set(r.provider, [r.model]);
    }
    return [...groups].map(([p, models]) => ({ provider: p, models }));
  }

  /** 添加模型（幂等）；sort 追加到组尾 */
  add(provider: string, model: string): void {
    const p = provider.trim();
    const m = model.trim();
    if (!p || !m) throw new Error("供应商与模型 id 不能为空");
    const next =
      (
        this.db
          .prepare("SELECT COALESCE(MAX(sort), -1) + 1 AS next FROM provider_models WHERE provider = ?")
          .get(p) as { next: number }
      ).next ?? 0;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO provider_models (provider, model, sort, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(p, m, Number(next), Date.now());
  }

  /** 删除模型；不存在时静默（幂等） */
  remove(provider: string, model: string): void {
    this.db
      .prepare("DELETE FROM provider_models WHERE provider = ? AND model = ?")
      .run(provider.trim(), model.trim());
  }
}
