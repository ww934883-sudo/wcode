import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * 版本化 schema 迁移（参考 ZCode cli/db 的 schema_migration 表）。
 * 每个迁移在单事务内应用：DDL 成功且登记行写入才提交；后续加列/表走这里，
 * 不赌 ALTER 的运气。payload JSON 为权威数据，提取列只为查询（设计 §4）。
 */
export interface Migration {
  id: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: "0001-init",
    up: [
      `CREATE TABLE sessions (
        id            TEXT PRIMARY KEY,
        project_hash  TEXT NOT NULL,
        cwd           TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        title         TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX idx_sessions_project ON sessions(project_hash, updated_at DESC)`,
      `CREATE TABLE messages (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        idx        INTEGER NOT NULL,
        role       TEXT NOT NULL,
        text       TEXT,
        payload    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_messages_session ON messages(session_id, idx)`,
      `CREATE TABLE events (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        event      TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    ].join(";\n"),
  },
];

/** 应用全部未执行的迁移；幂等（已登记的 id 跳过），返回本次新应用的迁移 id */
export function runMigrations(
  db: DatabaseSync,
  opts: { appVersion?: string } = {},
): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    id            TEXT PRIMARY KEY,
    checksum      TEXT NOT NULL,
    app_version   TEXT,
    time_applied  TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare("SELECT id FROM schema_migration").all() as { id: string }[]).map(
      (r) => r.id,
    ),
  );
  const fresh: string[] = [];
  const insert = db.prepare(
    "INSERT INTO schema_migration (id, checksum, app_version, time_applied) VALUES (?, ?, ?, ?)",
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const checksum = createHash("sha256").update(m.up).digest("hex");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.up);
      insert.run(m.id, checksum, opts.appVersion ?? null, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    fresh.push(m.id);
  }
  return fresh;
}

/**
 * 一次性标记行：JSONL 历史导入完成后写入（设计 §5）。
 * checksum 记录「导入数:跳过数」，仅作观测，幂等去重以 sessions.id 为准。
 */
export function markJsonlImportDone(
  db: DatabaseSync,
  imported: number,
  skipped: number,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO schema_migration (id, checksum, app_version, time_applied) VALUES (?, ?, ?, ?)",
  ).run(
    "migrated_from_jsonl",
    `${imported}:${skipped}`,
    null,
    new Date().toISOString(),
  );
}
