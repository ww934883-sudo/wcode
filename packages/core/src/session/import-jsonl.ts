import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { errorMessage } from "../errors";
import type { Logger } from "../logging/port";
import { markJsonlImportDone } from "./migrations";
import { previewOf } from "./sqlite-store";
import { projectDirHash, type SessionLine } from "./store";

/**
 * JSONL → SQLite 一次性迁移（设计 §5）：
 * 条件 = 驱动为 sqlite 且 sessions 表为空 且 ~/.wcode/projects/ 存在 JSONL。
 * 幂等（以 session id 去重）；单文件失败跳过并告警，不阻塞启动。
 * 旧文件保留不删除（用户数据，谨慎），README 说明手动清理方式。
 */
export async function importLegacyJsonl(
  db: DatabaseSync,
  opts: { homeDir?: string; log?: Logger } = {},
): Promise<void> {
  const n = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n,
  );
  if (n > 0) return; // 已有数据（含此前导入过），幂等快速路径

  const root = join(opts.homeDir ?? homedir(), ".wcode", "projects");
  const files: string[] = [];
  try {
    for (const hash of await readdir(root)) {
      const dir = join(root, hash);
      for (const name of await readdir(dir)) {
        if (name.endsWith(".jsonl")) files.push(join(dir, name));
      }
    }
  } catch {
    return; // 目录不存在 = 无历史可迁
  }
  if (files.length === 0) return;
  files.sort();

  let imported = 0;
  let skipped = 0;
  for (const file of files) {
    try {
      if (await importOneFile(db, file)) imported++;
      else skipped++;
    } catch (err) {
      opts.log?.warn("storage.import-jsonl.failed", {
        file,
        error: errorMessage(err),
      });
      skipped++;
    }
  }
  markJsonlImportDone(db, imported, skipped);
  opts.log?.info("storage.import-jsonl.done", { imported, skipped });
}

async function importOneFile(db: DatabaseSync, file: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return false;
  }
  const lines: SessionLine[] = [];
  for (const l of raw.split("\n")) {
    const t = l.trim();
    if (!t) continue;
    try {
      lines.push(JSON.parse(t) as SessionLine);
    } catch {
      // 损坏行跳过（与 JsonlSessionStore.load 同一容错语义）
    }
  }
  const meta = lines.find((l): l is Extract<SessionLine, { type: "meta" }> => l.type === "meta");
  const sessionId = meta?.sessionId ?? basename(file).replace(/\.jsonl$/, "");
  const messages = lines.filter(
    (l): l is Extract<SessionLine, { type: "message" }> => l.type === "message",
  );
  const events = lines.filter(
    (l): l is Extract<SessionLine, { type: "event" }> => l.type === "event",
  );
  // 纯 meta 空会话不导入（/resume 列表不被空壳污染；--continue 落在最近真实会话）
  if (messages.length === 0 && events.length === 0) return false;

  if (db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId)) {
    return false; // 已导入，幂等
  }

  const mtimeMs = (await stat(file).catch(() => null))?.mtimeMs ?? Date.now();
  const createdAt = (meta ? Date.parse(meta.createdAt) : NaN) || mtimeMs;
  // 项目分区：有 meta 用 cwd 哈希；无 meta 时父目录名本身就是 djb2 哈希
  const projectHash = meta ? projectDirHash(meta.cwd) : basename(join(file, ".."));
  const cwd = meta?.cwd ?? "";

  const firstUser = messages.find(
    (l) => l.message.role === "user" && typeof l.message.content === "string",
  );
  const title = firstUser && firstUser.message.role === "user"
    ? previewOf(firstUser.message.content) || null
    : null;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const l of messages) {
    if (l.message.role === "assistant" && l.message.usage) {
      inputTokens += l.message.usage.inputTokens;
      outputTokens += l.message.usage.outputTokens;
    }
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO sessions (id, project_hash, cwd, created_at, updated_at, title, message_count, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      sessionId,
      projectHash,
      cwd,
      createdAt,
      mtimeMs,
      title,
      messages.length,
      inputTokens,
      outputTokens,
    );
    const insertMsg = db.prepare(
      "INSERT INTO messages (session_id, idx, role, text, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    messages.forEach((l, i) => {
      const m = l.message;
      const text =
        m.role === "user"
          ? typeof m.content === "string"
            ? m.content
            : null
          : m.role === "assistant"
            ? m.text
            : m.results.map((r) => r.content).join("\n") || null;
      insertMsg.run(sessionId, i, m.role, text, JSON.stringify(m), createdAt);
    });
    const insertEvent = db.prepare(
      "INSERT INTO events (session_id, event, created_at) VALUES (?, ?, ?)",
    );
    for (const l of events) {
      insertEvent.run(sessionId, JSON.stringify(l.event), createdAt);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return true;
}
