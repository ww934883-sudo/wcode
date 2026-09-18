import type { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { errorMessage } from "../errors";
import type { Logger } from "../logging/port";
import { runMigrations } from "./migrations";
import {
  excerptOf,
  messageSearchText,
  type SessionLine,
  type SessionSearchHit,
  type SessionStats,
  type SessionStore,
  type SessionSummary,
} from "./store";

/**
 * SQLite 会话存储（设计 §2/§4）：node:sqlite 零依赖实现，要求 Node ≥ 24。
 * payload JSON 为权威数据，role/text 提取列只为查询；WAL + busy_timeout 兜底。
 * 注意：Node 24 下导入 node:sqlite 会向 stderr 打一条实验特性警告（C++ 层直接输出，
 * 监听器拦不住）——CLI 入口以 `--disable-warning=ExperimentalWarning` 启动规避；
 * 该警告不影响功能，stdout 的机器可读输出（headless --output-format=json）始终干净。
 */

let sqliteModule: typeof import("node:sqlite") | undefined;

async function loadSqlite(): Promise<typeof import("node:sqlite")> {
  if (!sqliteModule) {
    sqliteModule = await import("node:sqlite");
  }
  return sqliteModule;
}

/** 同进程连接缓存：driver 的 open/createNew 产出多个 store 视图共享一个连接 */
const dbCache = new Map<string, DatabaseSync>();

/** 打开（或复用）数据库连接并确保 schema 就绪；:memory: 不缓存（测试隔离） */
export async function openSqliteDb(
  dbPath: string,
  log?: Logger,
): Promise<DatabaseSync> {
  const cached = dbCache.get(dbPath);
  if (cached) return cached;
  const { DatabaseSync } = await loadSqlite();
  if (dbPath !== ":memory:") {
    // SQLite 不创建父目录；~/.wcode 可能尚不存在（首次安装）
    await mkdir(dirname(dbPath), { recursive: true }).catch(() => {});
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
  } catch (err) {
    throw new Error(`会话数据库打开失败（${dbPath}）: ${errorMessage(err)}`);
  }
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  const applied = runMigrations(db);
  if (applied.length > 0) {
    log?.info("storage.migrated", { dbPath, migrations: applied });
  }
  if (dbPath !== ":memory:") dbCache.set(dbPath, db);
  return db;
}

/** 关闭连接并出缓存：WAL 落盘检查点，测试里才能立刻删干净临时目录（Windows EBUSY 重试要数秒） */
export function closeSqliteDb(dbPath: string): void {
  const db = dbCache.get(dbPath);
  if (!db) return;
  dbCache.delete(dbPath);
  try {
    db.close();
  } catch {
    // 已关闭/损坏：忽略
  }
}

/** 关闭本进程全部会话库连接（测试清理用） */
export function closeAllSqliteDbs(): void {
  for (const p of [...dbCache.keys()]) closeSqliteDb(p);
}

export interface SqliteStoreCtx {
  db: DatabaseSync;
  /** 本视图绑定的会话 */
  sessionId: string;
  projectHash: string;
  cwd: string;
  log?: Logger;
  /**
   * 新建会话的懒落 meta（仅 createNew 产出的视图持有）：
   * 首条 append 时才建 sessions 行，空会话不留痕。
   */
  pendingCreatedAt?: string;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 预览/标题统一截断规则（首条用户消息折叠空白取 60 字） */
export function previewOf(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 60);
}

function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export class SqliteSessionStore implements SessionStore {
  /** 单调时间戳：同一实例内 append 严格递增，保证回放序=插入序（含同毫秒） */
  private lastTs = 0;

  constructor(private readonly ctx: SqliteStoreCtx) {}

  private nextTs(): number {
    this.lastTs = Math.max(Date.now(), this.lastTs + 1);
    return this.lastTs;
  }

  async append(line: SessionLine): Promise<void> {
    const { db, sessionId } = this.ctx;
    const now = this.nextTs();

    // 行保险：sessions 行缺失时补建（懒 meta 的 open 视图、外部误删后的自愈）。
    // createNew 视图持有 pendingCreatedAt，保证建行时间=创建时间；其余视图用 now。
    const pendingAt = this.ctx.pendingCreatedAt;
    inTransaction(db, () => {
      db.prepare(
        "INSERT OR IGNORE INTO sessions (id, project_hash, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        sessionId,
        this.ctx.projectHash,
        this.ctx.cwd,
        pendingAt !== undefined ? Date.parse(pendingAt) || now : now,
        now,
      );
    });
    this.ctx.pendingCreatedAt = undefined;

    if (line.type === "meta") {
      inTransaction(db, () => {
        db.prepare(
          "INSERT OR IGNORE INTO sessions (id, project_hash, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).run(
          sessionId,
          this.ctx.projectHash,
          line.cwd,
          Date.parse(line.createdAt) || now,
          now,
        );
      });
      return;
    }

    if (line.type === "event") {
      inTransaction(db, () => {
        db.prepare(
          "INSERT INTO events (session_id, event, created_at) VALUES (?, ?, ?)",
        ).run(sessionId, JSON.stringify(line.event), now);
        db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
      });
      return;
    }

    if (line.type === "truncate") {
      // 原地回退：sqlite 无追加语义，直接删除截断点之后的消息行并重算计数
      inTransaction(db, () => {
        db.prepare("DELETE FROM messages WHERE session_id = ? AND idx >= ?").run(
          sessionId,
          line.keepMessages,
        );
        const rows = db
          .prepare("SELECT payload FROM messages WHERE session_id = ? ORDER BY idx")
          .all(sessionId) as { payload: string }[];
        let messageCount = 0;
        let inputTokens = 0;
        let outputTokens = 0;
        for (const r of rows) {
          try {
            const m = JSON.parse(r.payload) as { role?: string; usage?: { inputTokens: number; outputTokens: number } };
            messageCount++;
            if (m.role === "assistant" && m.usage) {
              inputTokens += m.usage.inputTokens;
              outputTokens += m.usage.outputTokens;
            }
          } catch {
            // payload 损坏：跳过该行计数，不阻塞回退
          }
        }
        db.prepare(
          "UPDATE sessions SET message_count = ?, input_tokens = ?, output_tokens = ?, updated_at = ? WHERE id = ?",
        ).run(messageCount, inputTokens, outputTokens, now, sessionId);
      });
      return;
    }

    // message：INSERT + sessions 计数/token 更新 = 单事务（设计 §4）
    const message = line.message;
    const text = messageSearchText(message);
    inTransaction(db, () => {
      const idx = Number(
        (
          db
            .prepare("SELECT COALESCE(MAX(idx), -1) + 1 AS next FROM messages WHERE session_id = ?")
            .get(sessionId) as { next: number }
        ).next,
      );
      db.prepare(
        "INSERT INTO messages (session_id, idx, role, text, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(sessionId, idx, message.role, text, JSON.stringify(message), now);

      const usage =
        message.role === "assistant" ? (message.usage ?? null) : null;
      db.prepare(
        `UPDATE sessions SET
           updated_at = ?,
           message_count = message_count + 1,
           input_tokens = input_tokens + ?,
           output_tokens = output_tokens + ?,
           title = COALESCE(title, ?)
         WHERE id = ?`,
      ).run(
        now,
        usage?.inputTokens ?? 0,
        usage?.outputTokens ?? 0,
        message.role === "user" && text ? previewOf(text) || null : null,
        sessionId,
      );
    });
  }

  async load(): Promise<SessionLine[]> {
    const { db, sessionId } = this.ctx;
    const log = this.ctx.log;
    const lines: SessionLine[] = [];

    const meta = db
      .prepare("SELECT id, created_at, cwd FROM sessions WHERE id = ?")
      .get(sessionId) as { id: string; created_at: number; cwd: string } | undefined;
    if (meta) {
      lines.push({
        v: 1,
        type: "meta",
        sessionId: meta.id,
        createdAt: iso(Number(meta.created_at)),
        cwd: meta.cwd,
      });
    }

    type Row = { at: number; pri: number; line: SessionLine };
    const rows: Row[] = [];
    for (const r of db
      .prepare("SELECT payload, created_at FROM messages WHERE session_id = ? ORDER BY idx")
      .all(sessionId) as { payload: string; created_at: number }[]) {
      try {
        rows.push({
          at: Number(r.created_at),
          pri: 0,
          line: { v: 1, type: "message", message: JSON.parse(r.payload) },
        });
      } catch {
        log?.warn("会话消息 payload 损坏，已跳过", { sessionId });
      }
    }
    for (const r of db
      .prepare("SELECT event, created_at FROM events WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as { event: string; created_at: number }[]) {
      try {
        rows.push({
          at: Number(r.created_at),
          pri: 1,
          line: { v: 1, type: "event", event: JSON.parse(r.event) },
        });
      } catch {
        log?.warn("会话事件损坏，已跳过", { sessionId });
      }
    }
    rows.sort((a, b) => a.at - b.at || a.pri - b.pri);
    lines.push(...rows.map((r) => r.line));
    return lines;
  }

  async listRecent(limit = 10): Promise<SessionSummary[]> {
    const rows = this.ctx.db
      .prepare(
        "SELECT id, created_at, message_count, title FROM sessions WHERE project_hash = ? AND message_count > 0 ORDER BY updated_at DESC, id DESC LIMIT ?",
      )
      .all(this.ctx.projectHash, limit) as {
      id: string;
      created_at: number;
      message_count: number;
      title: string | null;
    }[];
    return rows.map((r) => ({
      sessionId: r.id,
      createdAt: iso(Number(r.created_at)),
      messageCount: Number(r.message_count),
      preview: r.title ?? "",
    }));
  }

  async findLatest(): Promise<string | null> {
    const row = this.ctx.db
      .prepare(
        "SELECT id FROM sessions WHERE project_hash = ? ORDER BY updated_at DESC, id DESC LIMIT 1",
      )
      .get(this.ctx.projectHash) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** LIKE 检索提取列 text（%/_/\\ 字面转义）；新会话在前，消息级命中 */
  async search(keyword: string, limit = 10): Promise<SessionSearchHit[]> {
    const kw = keyword.trim();
    if (!kw) return [];
    const pattern = `%${kw.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.ctx.db
      .prepare(
        `SELECT s.id AS sid, s.created_at AS created_at, s.message_count AS mc,
                m.idx AS idx, m.role AS role, m.text AS text
         FROM messages m JOIN sessions s ON s.id = m.session_id
         WHERE s.project_hash = ? AND m.text LIKE ? ESCAPE '\\'
         ORDER BY s.updated_at DESC, s.id DESC, m.idx ASC
         LIMIT ?`,
      )
      .all(this.ctx.projectHash, pattern, limit) as {
      sid: string;
      created_at: number;
      mc: number;
      idx: number;
      role: string;
      text: string | null;
    }[];
    return rows.map((r) => ({
      sessionId: r.sid,
      createdAt: iso(Number(r.created_at)),
      messageCount: Number(r.mc),
      messageIndex: Number(r.idx) + 1,
      role: String(r.role),
      excerpt: excerptOf(String(r.text ?? ""), kw),
    }));
  }

  async stats(): Promise<SessionStats> {
    const row = this.ctx.db
      .prepare(
        `SELECT COUNT(*) AS sc,
                COALESCE(SUM(message_count), 0) AS mc,
                COALESCE(SUM(input_tokens), 0) AS it,
                COALESCE(SUM(output_tokens), 0) AS ot
         FROM sessions WHERE project_hash = ?`,
      )
      .get(this.ctx.projectHash) as { sc: number; mc: number; it: number; ot: number };
    return {
      sessionCount: Number(row.sc),
      messageCount: Number(row.mc),
      inputTokens: Number(row.it),
      outputTokens: Number(row.ot),
    };
  }
}
