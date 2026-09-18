import type { Logger } from "../logging/port";
import { openSqliteDb } from "../session/sqlite-store";

/** 目录条目：模型 id + 可选上下文标注（如 "1M"/"200K"） */
export interface CatalogModelEntry {
  model: string;
  contextLabel?: string;
}

/** 按供应商分组的模型目录条目（provider 组内保持添加序） */
export interface ModelCatalogGroup {
  provider: string;
  models: CatalogModelEntry[];
}

/** updateModel 的部分更新载荷；contextLabel: null = 清除标注 */
export interface CatalogModelPatch {
  model?: string;
  contextLabel?: string | null;
}

/**
 * 供应商模型目录（SQLite provider_models 表，迁移 0003/0004）：
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
              "SELECT provider, model, context_label FROM provider_models WHERE provider = ? ORDER BY sort, created_at",
            )
            .all(provider)
        : this.db
            .prepare(
              "SELECT provider, model, context_label FROM provider_models ORDER BY provider, sort, created_at",
            )
            .all()
    ) as { provider: string; model: string; context_label: string | null }[];
    const groups = new Map<string, CatalogModelEntry[]>();
    for (const r of rows) {
      const list = groups.get(r.provider);
      const entry: CatalogModelEntry = {
        model: r.model,
        ...(r.context_label ? { contextLabel: r.context_label } : {}),
      };
      if (list) list.push(entry);
      else groups.set(r.provider, [entry]);
    }
    return [...groups].map(([p, models]) => ({ provider: p, models }));
  }

  /** 添加模型（幂等）；sort 追加到组尾 */
  add(provider: string, model: string, contextLabel?: string): void {
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
        "INSERT OR IGNORE INTO provider_models (provider, model, sort, created_at, context_label) VALUES (?, ?, ?, ?, ?)",
      )
      .run(p, m, Number(next), Date.now(), contextLabel?.trim() || null);
  }

  /** 删除模型；不存在时静默（幂等） */
  remove(provider: string, model: string): void {
    this.db
      .prepare("DELETE FROM provider_models WHERE provider = ? AND model = ?")
      .run(provider.trim(), model.trim());
  }

  /** 删除供应商整组（供应商被删除时级联） */
  removeProvider(provider: string): void {
    this.db.prepare("DELETE FROM provider_models WHERE provider = ?").run(provider.trim());
  }

  /** 部分更新模型条目：改 id（改名）或改上下文标注 */
  updateModel(provider: string, model: string, patch: CatalogModelPatch): void {
    const p = provider.trim();
    const m = model.trim();
    if (!p || !m) throw new Error("供应商与模型 id 不能为空");
    const row = this.db
      .prepare("SELECT sort, created_at FROM provider_models WHERE provider = ? AND model = ?")
      .get(p, m) as { sort: number; created_at: number } | undefined;
    if (!row) throw new Error(`模型不存在：${p} / ${m}`);
    const newModel = patch.model?.trim() || m;
    const contextLabel =
      patch.contextLabel === null ? null : (patch.contextLabel?.trim() || null);
    this.db
      .prepare(
        "INSERT OR REPLACE INTO provider_models (provider, model, sort, created_at, context_label) VALUES (?, ?, ?, ?, ?)",
      )
      .run(p, newModel, Number(row.sort), Number(row.created_at), contextLabel);
    // 改名时清掉被替换的旧 id（INSERT OR REPLACE 不按旧主键删）
    if (newModel !== m) {
      this.db
        .prepare("DELETE FROM provider_models WHERE provider = ? AND model = ?")
        .run(p, m);
    }
  }

  /** 供应商改名：整组迁移（设置页重命名供应商时级联） */
  renameProvider(oldName: string, newName: string): void {
    const from = oldName.trim();
    const to = newName.trim();
    if (!from || !to || from === to) return;
    this.db
      .prepare("UPDATE provider_models SET provider = ? WHERE provider = ?")
      .run(to, from);
  }
}
