import { createHash } from "node:crypto";
import type { Message, Usage } from "../types";
import type { Rule } from "../permission/rules";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  priority?: "high" | "medium" | "low";
}

export interface BackgroundTaskInfo {
  id: string;
  command: string;
  pid?: number;
  shell: string;
  outputPath: string;
  startedAt: number;
  done: boolean;
  exitCode?: number;
}

export interface SessionState {
  id: string;
  cwd: string;
  messages: Message[];
  /** 本会话已读文件：绝对路径（规范化）→ 读取时的内容哈希。Write/Edit 过期保护依据 */
  filesRead: Map<string, string>;
  /** 会话内 "总是允许" 学习到的规则（架构文档 §3.5） */
  sessionRules: Rule[];
  cumulativeUsage: Usage;
  /** 任务清单（todo_write/todo_read 维护） */
  todos: TodoItem[];
  /** 后台任务注册表（bash run_in_background / task_output / task_stop） */
  backgroundTasks: Map<string, BackgroundTaskInfo>;
}

export function createSessionState(cwd: string, id?: string): SessionState {
  return {
    id: id ?? `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    cwd,
    messages: [],
    filesRead: new Map(),
    sessionRules: [],
    cumulativeUsage: { inputTokens: 0, outputTokens: 0 },
    todos: [],
    backgroundTasks: new Map(),
  };
}

export function contentHash(content: string): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 16);
}
