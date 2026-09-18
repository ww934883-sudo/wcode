import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../logging/port";
import { importLegacyJsonl } from "./import-jsonl";
import { closeSqliteDb, openSqliteDb, SqliteSessionStore } from "./sqlite-store";
import {
  jsonlSessionPath,
  JsonlSessionStore,
  projectDirHash,
  type SessionSearchHit,
  type SessionStats,
  type SessionStore,
  type SessionSummary,
} from "./store";

export type StorageType = "sqlite" | "jsonl";

/**
 * 项目级会话存储入口：发现（/resume 列表、--continue）+ 打开/新建（bootstrap 装配）。
 * 组合根（bootstrap）按 storage.type 在这里做唯一一次实现分支，core 其余与 UI 零感知。
 */
export interface SessionDriver {
  listRecent(limit?: number): Promise<SessionSummary[]>;
  /** 最近一次会话的 sessionId（--continue）；无历史返回 null */
  findLatest(): Promise<string | null>;
  /** 绑定到既有会话（/resume、--resume <id>） */
  open(sessionId: string): Promise<SessionStore>;
  /** 新建会话并立即落 meta；返回生成的 sessionId */
  createNew(init: { cwd: string }): Promise<{ sessionId: string; store: SessionStore }>;
  /** 跨会话关键词搜索（W-b /sessions <关键词>）：消息级命中，新会话在前 */
  search(keyword: string, limit?: number): Promise<SessionSearchHit[]>;
  /** 用量统计（W-b /stats）：本项目聚合 */
  stats(): Promise<SessionStats>;
  /** 删除会话（连消息/事件一起）；会话不存在时静默成功（幂等） */
  delete(sessionId: string): Promise<void>;
  /** 释放底层资源（sqlite 关连接并做 WAL 检查点；jsonl 无操作） */
  close(): void;
}

/** 会话 id：ISO 时间戳替换非法字符（沿用旧命名，字典序=时间序，人类可读） */
export function newSessionId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export interface SessionDriverOptions {
  storageType: StorageType;
  cwd: string;
  log?: Logger;
  /** 测试注入家目录（默认 homedir()） */
  homeDir?: string;
}

export async function createSessionDriver(
  opts: SessionDriverOptions,
): Promise<SessionDriver> {
  const home = opts.homeDir ?? homedir();
  const log = opts.log;

  if (opts.storageType === "sqlite") {
    const dbPath = join(home, ".wcode", "wcode.db");
    const db = await openSqliteDb(dbPath, log);
    await importLegacyJsonl(db, { homeDir: home, log });
    const projectHash = projectDirHash(opts.cwd);
    const index = new SqliteSessionStore({ db, sessionId: "", projectHash, cwd: opts.cwd, log });
    return {
      listRecent: (limit) => index.listRecent(limit),
      findLatest: () => index.findLatest(),
      search: (keyword, limit) => index.search(keyword, limit),
      stats: () => index.stats(),
      delete: async (sessionId) => {
        // messages/events 外键 ON DELETE CASCADE，删 sessions 行即全量清理；
        // project_hash 限定防止串项目误删
        db.prepare("DELETE FROM sessions WHERE id = ? AND project_hash = ?").run(
          sessionId,
          projectHash,
        );
      },
      open: async (sessionId) =>
        new SqliteSessionStore({ db, sessionId, projectHash, cwd: opts.cwd, log }),
      createNew: async (init) => {
        const sessionId = newSessionId();
        const store = new SqliteSessionStore({ db, sessionId, projectHash, cwd: init.cwd, log });
        await store.append({
          v: 1,
          type: "meta",
          sessionId,
          createdAt: new Date().toISOString(),
          cwd: init.cwd,
        });
        return { sessionId, store };
      },
      close: () => closeSqliteDb(dbPath),
    };
  }

  // jsonl 驱动：目录扫描兜底发现（resume.ts 的旧逻辑收敛为实现细节）
  const sessionsDir = join(home, ".wcode", "projects", projectDirHash(opts.cwd));
  await mkdir(sessionsDir, { recursive: true }).catch(() => {});
  // 发现视图：只用于 listRecent/findLatest（按 dirname 扫描），从不 append/load
  const index = new JsonlSessionStore(jsonlSessionPath(sessionsDir, "index-probe"), log);
  return {
      listRecent: (limit) => index.listRecent(limit),
      findLatest: () => index.findLatest(),
      search: (keyword, limit) => index.search(keyword, limit),
      stats: () => index.stats(),
      delete: async (sessionId) => {
        // jsonlSessionPath 自带 id 白名单校验（防路径穿越）；文件不存在视为已删
        await rm(jsonlSessionPath(sessionsDir, sessionId), { force: true });
      },
      open: async (sessionId) => new JsonlSessionStore(jsonlSessionPath(sessionsDir, sessionId), log),
    createNew: async (init) => {
      const sessionId = newSessionId();
      const store = new JsonlSessionStore(jsonlSessionPath(sessionsDir, sessionId), log);
      await store.append({
        v: 1,
        type: "meta",
        sessionId,
        createdAt: new Date().toISOString(),
        cwd: init.cwd,
      }).catch(() => {}); // 与旧行为一致：meta 落盘失败不阻塞启动
      return { sessionId, store };
    },
    close: () => undefined,
  };
}
