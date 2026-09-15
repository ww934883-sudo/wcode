/** 评测集类型定义（架构文档 §17 风险 4：真实任务小评测集） */

export type EvalCheck =
  | { type: "file_exists"; path: string }
  | { type: "file_absent"; path: string }
  | { type: "file_contains"; path: string; must_all?: string[]; must_none?: string[] }
  | { type: "file_regex"; path: string; pattern: string; flags?: string }
  | { type: "json_equals"; path: string; field: string; value: unknown }
  | {
      type: "command";
      command: string;
      expect_exit?: number;
      output_contains?: string;
    };

export interface EvalTask {
  id: string;
  title: string;
  category: string;
  prompt: string;
  /** 任务工作区内预置的文件（相对路径 → 内容） */
  files?: Record<string, string>;
  checks: EvalCheck[];
}

export type EvalStatus = "passed" | "failed" | "error" | "timeout";

export interface EvalTaskResult {
  id: string;
  title: string;
  category: string;
  pass: boolean;
  status: EvalStatus;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  turns: number;
  failedChecks: string[];
  error?: string;
  /** 失败且 keepWorkspaces 时保留，便于人工排查 */
  workspace?: string;
}

export interface SuiteReport {
  suite: string;
  startedAt: string;
  finishedAt: string;
  model: string;
  provider: string;
  results: EvalTaskResult[];
  passed: number;
  total: number;
}
