import { createHash } from "node:crypto";
import type { Message, Usage } from "../types";
import type { Rule } from "../permission/rules";

export interface SessionState {
  id: string;
  cwd: string;
  messages: Message[];
  /** 本会话已读文件：绝对路径（规范化）→ 读取时的内容哈希。Write/Edit 过期保护依据 */
  filesRead: Map<string, string>;
  /** 会话内 "总是允许" 学习到的规则（架构文档 §3.5） */
  sessionRules: Rule[];
  cumulativeUsage: Usage;
}

export function createSessionState(cwd: string, id?: string): SessionState {
  return {
    id: id ?? `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    cwd,
    messages: [],
    filesRead: new Map(),
    sessionRules: [],
    cumulativeUsage: { inputTokens: 0, outputTokens: 0 },
  };
}

export function contentHash(content: string): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 16);
}
