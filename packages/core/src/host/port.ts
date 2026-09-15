import type { ToolCall } from "../types";
import type { Usage } from "../types";

/** 单向事件流：core → UI。封闭的判别联合，新增事件即新增 UI 挂载点。 */
export type AgentEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; call: ToolCall }
  | {
      type: "tool_end";
      callId: string;
      toolName: string;
      ok: boolean;
      summary: string;
      durationMs: number;
    }
  | { type: "usage"; usage: Usage; cumulative: Usage }
  | { type: "error"; message: string }
  | { type: "done"; reason: "end_turn" | "max_turns" | "aborted" };

export interface PermissionRequest {
  toolName: string;
  input: unknown;
  /** 供权限规则匹配的模式串，如 "Edit(src/app.ts)" */
  patterns: string[];
}

export type PermissionDecision = "allow" | "deny" | "allowAlways";

/**
 * 人机交互反向端口（接缝三）。core 需要人做决策时调用，
 * UI（M1 readline / M3 ink）实现本接口。
 */
export interface AgentHost {
  emit(event: AgentEvent): void;
  requestPermission(req: PermissionRequest): Promise<PermissionDecision>;
}
