import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "../types";
import type { SessionLine } from "./store";

/** 从会话 JSONL 行中重放消息历史（损坏行已在 store.load() 容错） */
export function messagesFromSessionLines(lines: SessionLine[]): Message[] {
  return lines
    .filter((l): l is Extract<SessionLine, { type: "message" }> => l.type === "message")
    .map((l) => l.message);
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
