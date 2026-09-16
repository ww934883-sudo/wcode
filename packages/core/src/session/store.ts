import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Message } from "../types";
import { errorMessage } from "../errors";
import type { Logger } from "../logging/port";

/** 会话持久化格式 v1（架构文档 §4.3）。append-only，逐行带版本号。 */
export type SessionLine =
  | { v: 1; type: "meta"; sessionId: string; createdAt: string; cwd: string }
  | { v: 1; type: "message"; message: Message }
  | { v: 1; type: "event"; event: Record<string, unknown> };

/** /resume 列表项（会话 id 即可重新打开，路径不外泄给调用方） */
export interface SessionSummary {
  sessionId: string;
  createdAt?: string;
  messageCount: number;
  /** 首条用户消息的前 60 字符 */
  preview: string;
}

export interface SessionStore {
  append(line: SessionLine): Promise<void>;
  /** resume 时重放；损坏行跳过并告警，不阻塞恢复 */
  load(): Promise<SessionLine[]>;
  /**
   * 发现类能力方法（可选，沿用 ModelProvider.listModels 先例）：
   * /resume 列表，新→旧，默认 10 条。
   */
  listRecent?(limit?: number): Promise<SessionSummary[]>;
  /** --continue：最近一次会话的 sessionId；无历史返回 null */
  findLatest?(): Promise<string | null>;
}

export class JsonlSessionStore implements SessionStore {
  private mkdirPromise?: Promise<void>;

  constructor(
    private readonly filePath: string,
    private readonly log?: Logger,
  ) {}

  async append(line: SessionLine): Promise<void> {
    await this.ensureDir();
    await appendFile(this.filePath, JSON.stringify(line) + "\n", "utf8");
  }

  async load(): Promise<SessionLine[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return [];
    }
    const lines: SessionLine[] = [];
    for (const l of raw.split("\n")) {
      const trimmed = l.trim();
      if (!trimmed) continue;
      try {
        lines.push(JSON.parse(trimmed) as SessionLine);
      } catch {
        this.log?.warn("会话文件存在损坏行，已跳过", { filePath: this.filePath });
      }
    }
    return lines;
  }

  /** 目录扫描兜底实现（存储子目录内本项目全部会话，新→旧） */
  async listRecent(limit = 10): Promise<SessionSummary[]> {
    const dir = dirname(this.filePath);
    const summaries: SessionSummary[] = [];
    const files = (await sortedSessionFiles(dir)).reverse(); // 文件名升序=时间升序，反转即新→旧
    for (const file of files) {
      if (summaries.length >= limit) break;
      let createdAt: string | undefined;
      let messageCount = 0;
      let preview = "";
      try {
        const text = await readFile(join(dir, file), "utf8");
        for (const line of text.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          let parsed: SessionLine;
          try {
            parsed = JSON.parse(t) as SessionLine;
          } catch {
            continue; // 损坏行跳过
          }
          if (parsed.type === "meta") {
            createdAt = parsed.createdAt;
          } else if (parsed.type === "message") {
            messageCount++;
            if (!preview && parsed.message.role === "user") {
              const content = parsed.message.content;
              preview =
                typeof content === "string"
                  ? content.replace(/\s+/g, " ")
                  : "（富媒体消息）";
            }
          }
        }
      } catch {
        continue; // 不可读文件跳过
      }
      summaries.push({
        sessionId: file.replace(/\.jsonl$/, ""),
        createdAt,
        messageCount,
        preview: preview.slice(0, 60),
      });
    }
    return summaries;
  }

  /** 文件名含 ISO 时间戳，字典序即时间序；返回最近的 sessionId */
  async findLatest(): Promise<string | null> {
    const files = await sortedSessionFiles(dirname(this.filePath));
    const last = files[files.length - 1];
    return last ? last.replace(/\.jsonl$/, "") : null;
  }

  private ensureDir(): Promise<void> {
    if (this.mkdirPromise) {
      return this.mkdirPromise;
    }
    this.mkdirPromise = mkdir(dirname(this.filePath), { recursive: true }).then(
      () => undefined,
      (err: unknown) => {
        throw new Error(`会话目录不可写: ${errorMessage(err)}`);
      },
    );
    return this.mkdirPromise;
  }
}

/** 存储子目录内 .jsonl 文件名升序（ISO 时间戳命名，字典序=时间序） */
async function sortedSessionFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".jsonl")).sort();
}

/** 会话 id → JSONL 文件路径（jsonl 驱动的 open 语义） */
export function jsonlSessionPath(sessionsDir: string, sessionId: string): string {
  // 防路径穿越：sessionId 只允许时间戳形式的安全字符
  if (!/^[\w.-]+$/.test(sessionId)) {
    throw new Error(`非法会话 id: ${sessionId}`);
  }
  return join(sessionsDir, `${sessionId}.jsonl`);
}

/** 项目路径 → 存储子目录哈希（djb2），避免路径里的非法字符 */
export function projectDirHash(cwd: string): string {
  let hash = 5381;
  for (let i = 0; i < cwd.length; i++) {
    hash = ((hash << 5) + hash + cwd.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
