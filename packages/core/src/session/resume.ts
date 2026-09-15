import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "../types";
import type { SessionLine } from "./store";

/** 从会话 JSONL 行中重放消息历史（损坏行已在 store.load() 容错） */
export function messagesFromSessionLines(lines: SessionLine[]): Message[] {
  return lines
    .filter((l): l is Extract<SessionLine, { type: "message" }> => l.type === "message")
    .map((l) => l.message);
}

/** /resume 列表项 */
export interface SessionSummary {
  file: string;
  /** 文件名去掉 .jsonl（ISO 时间戳形式） */
  sessionId: string;
  createdAt?: string;
  messageCount: number;
  /** 首条用户消息的前 60 字符 */
  preview: string;
}

/** 列出目录下最近的会话（新→旧），每条解析 meta 与首条用户消息作预览 */
export async function listSessions(
  sessionsDir: string,
  limit = 10,
): Promise<SessionSummary[]> {
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return [];
  }
  const jsonl = names
    .filter((n) => n.endsWith(".jsonl"))
    .sort()
    .reverse()
    .slice(0, limit);
  const out: SessionSummary[] = [];
  for (const name of jsonl) {
    const file = join(sessionsDir, name);
    let createdAt: string | undefined;
    let messageCount = 0;
    let preview = "";
    try {
      const text = await readFile(file, "utf8");
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
              typeof content === "string" ? content.replace(/\s+/g, " ") : "（富媒体消息）";
          }
        }
      }
    } catch {
      continue; // 不可读文件跳过
    }
    out.push({
      file,
      sessionId: name.replace(/\.jsonl$/, ""),
      createdAt,
      messageCount,
      preview: preview.slice(0, 60),
    });
  }
  return out;
}

/** 找到目录下最近修改的会话文件（--continue 用） */
export async function findLatestSessionFile(
  sessionsDir: string,
): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return null;
  }
  const jsonl = names.filter((n) => n.endsWith(".jsonl")).sort();
  if (jsonl.length === 0) return null;
  // 文件名含 ISO 时间戳，字典序即时间序
  return join(sessionsDir, jsonl[jsonl.length - 1] as string);
}
