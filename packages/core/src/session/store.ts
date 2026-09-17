import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Message } from "../types";
import { errorMessage } from "../errors";
import type { Logger } from "../logging/port";

/** 会话持久化格式 v1（架构文档 §4.3）。append-only，逐行带版本号。 */
export type SessionLine =
  | { v: 1; type: "meta"; sessionId: string; createdAt: string; cwd: string }
  | { v: 1; type: "message"; message: Message }
  | { v: 1; type: "event"; event: Record<string, unknown> }
  /**
   * 原地回退标记（检查点回退）：把重放历史截断为前 keepMessages 条，
   * 之后的旧消息行保留在文件里但不再重放；后续新消息接在截断点上。
   * jsonl 是标记（旧数据可恢复），sqlite 实现为真删除。
   */
  | { v: 1; type: "truncate"; keepMessages: number; at: string };

/** /resume 列表项（会话 id 即可重新打开，路径不外泄给调用方） */
export interface SessionSummary {
  sessionId: string;
  createdAt?: string;
  messageCount: number;
  /** 首条用户消息的前 60 字符 */
  preview: string;
}

/** 跨会话搜索命中（W-b /sessions <关键词>） */
export interface SessionSearchHit {
  sessionId: string;
  createdAt?: string;
  messageCount: number;
  /** 命中消息的会话内序号（1 起） */
  messageIndex: number;
  /** user | assistant | tool_result */
  role: string;
  /** 关键词附近摘录（约 60 字） */
  excerpt: string;
}

/** 会话用量统计（W-b /stats），按项目（存储分区）聚合 */
export interface SessionStats {
  sessionCount: number;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
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
  /** 跨会话关键词搜索（W-b）：命中消息级条目，新会话在前 */
  search?(keyword: string, limit?: number): Promise<SessionSearchHit[]>;
  /** 用量统计（W-b /stats）：本项目聚合 */
  stats?(): Promise<SessionStats>;
}

/**
 * 消息的检索文本（提取列语义，两实现共用）：user 字符串内容 / assistant 文本 /
 * tool_result 结果拼接。payload 才是权威数据，这里只为搜索。
 */
export function messageSearchText(message: Message): string | null {
  if (message.role === "user") {
    return typeof message.content === "string" ? message.content : null;
  }
  if (message.role === "assistant") return message.text;
  return message.results.map((r) => r.content).join("\n") || null;
}

/** 关键词附近摘录：定位（忽略大小写）后取前后各 20 字，折叠空白 */
export function excerptOf(text: string, keyword: string): string {
  const collapsed = text.replace(/\s+/g, " ");
  const i = collapsed.toLowerCase().indexOf(keyword.toLowerCase());
  if (i < 0) return collapsed.slice(0, 60);
  const start = Math.max(0, i - 20);
  const end = Math.min(collapsed.length, i + keyword.length + 20);
  return (
    (start > 0 ? "…" : "") +
    collapsed.slice(start, end) +
    (end < collapsed.length ? "…" : "")
  );
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
          } else if (parsed.type === "truncate") {
            // 原地回退：计数与重放语义一致（只缩不涨）
            messageCount = Math.min(messageCount, parsed.keepMessages);
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

  /** 目录扫描兜底实现：逐文件逐消息匹配关键词（与 sqlite 的提取列语义一致） */
  async search(keyword: string, limit = 10): Promise<SessionSearchHit[]> {
    const kw = keyword.trim();
    if (!kw) return [];
    const dir = dirname(this.filePath);
    const files = (await sortedSessionFiles(dir)).reverse();
    const lower = kw.toLowerCase();
    const hits: SessionSearchHit[] = [];
    for (const file of files) {
      if (hits.length >= limit) break;
      let createdAt: string | undefined;
      let messageCount = 0;
      // 命中先攒着，文件解析完拿到消息总数再回填 messageCount
      const pending: { messageIndex: number; role: string; searchable: string }[] = [];
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
            continue;
          }
          if (parsed.type === "truncate") {
            // 原地回退：丢弃截断点之后的暂存命中，计数与重放语义一致
            messageCount = Math.min(messageCount, parsed.keepMessages);
            for (let i = pending.length - 1; i >= 0; i--) {
              const p = pending[i];
              if (p && p.messageIndex > parsed.keepMessages) pending.splice(i, 1);
            }
            continue;
          }
          if (parsed.type !== "message") continue;
          messageCount++;
          const searchable = messageSearchText(parsed.message);
          if (searchable && searchable.toLowerCase().includes(lower)) {
            pending.push({
              messageIndex: messageCount,
              role: parsed.message.role,
              searchable,
            });
          }
        }
      } catch {
        continue; // 不可读文件跳过
      }
      for (const p of pending) {
        if (hits.length >= limit) break;
        hits.push({
          sessionId: file.replace(/\.jsonl$/, ""),
          createdAt,
          messageCount,
          messageIndex: p.messageIndex,
          role: p.role,
          excerpt: excerptOf(p.searchable, kw),
        });
      }
    }
    return hits;
  }

  /** 目录扫描兜底实现：逐文件累加会话数/消息数/用量 */
  async stats(): Promise<SessionStats> {
    const dir = dirname(this.filePath);
    const files = await sortedSessionFiles(dir);
    const out: SessionStats = {
      sessionCount: 0,
      messageCount: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    for (const file of files) {
      out.sessionCount++;
      // 截断可发生在任意位置：逐消息记录用量，截断时切掉尾部再求和
      const usages: { inTok: number; outTok: number }[] = [];
      try {
        const text = await readFile(join(dir, file), "utf8");
        for (const line of text.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          let parsed: SessionLine;
          try {
            parsed = JSON.parse(t) as SessionLine;
          } catch {
            continue;
          }
          if (parsed.type === "truncate") {
            usages.length = Math.min(usages.length, parsed.keepMessages);
            continue;
          }
          if (parsed.type !== "message") continue;
          const usage =
            parsed.message.role === "assistant" ? parsed.message.usage : undefined;
          usages.push({
            inTok: usage?.inputTokens ?? 0,
            outTok: usage?.outputTokens ?? 0,
          });
        }
      } catch {
        continue;
      }
      out.messageCount += usages.length;
      for (const u of usages) {
        out.inputTokens += u.inTok;
        out.outputTokens += u.outTok;
      }
    }
    return out;
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
