import type { AgentEvent, Message, PermissionDecision, Usage } from "@wcode/core";
import type { PermissionAsk } from "../shared/protocol";

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      status: "running" | "ok" | "error";
      summary?: string;
      durationMs?: number;
    }
  | {
      kind: "permission";
      id: string;
      toolName: string;
      input: unknown;
      patterns: string[];
      decided?: PermissionDecision;
    }
  | { kind: "notice"; id: string; level: "error" | "info"; text: string };

export type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/**
 * 历史会话水合：SessionLine 重放出的 Message[] → 聊天项。
 * assistant 消息里的 toolCalls 生成工具卡，紧随的 tool_result 回填结果。
 */
export function itemsFromMessages(messages: Message[]): ChatItem[] {
  const items: ChatItem[] = [];
  const byCall = new Map<string, ToolItem>();
  for (const m of messages) {
    if (m.role === "user") {
      items.push({ kind: "user", id: `u-${items.length}`, text: m.content });
    } else if (m.role === "assistant") {
      items.push({
        kind: "assistant",
        id: `a-${items.length}`,
        text: m.text,
        streaming: false,
      });
      for (const c of m.toolCalls) {
        const card: ToolItem = {
          kind: "tool",
          id: c.id,
          name: c.name,
          input: c.input,
          status: "ok",
        };
        items.push(card);
        byCall.set(c.id, card);
      }
    } else {
      for (const r of m.results) {
        const card = byCall.get(r.callId);
        if (card) {
          card.status = r.isError ? "error" : "ok";
          card.summary = truncateOneLine(r.content);
        } else {
          items.push({
            kind: "tool",
            id: r.callId,
            name: "tool",
            input: null,
            status: r.isError ? "error" : "ok",
            summary: truncateOneLine(r.content),
          });
        }
      }
    }
  }
  return items;
}

export interface UiState {
  items: ChatItem[];
  usage: Usage | null;
  running: boolean;
}

export const emptyUiState: UiState = { items: [], usage: null, running: false };

export interface ErrorInfo {
  kind: "transient" | "auth" | "rate" | "network" | "generic";
  /** 可行动提示（transient/generic 无需额外文案） */
  hint: string;
  /** 展示「重试」按钮（重发最后一条用户输入） */
  retryable: boolean;
  /** 展示「打开设置」按钮 */
  openSettings: boolean;
}

/**
 * 错误文案 → 用户可行动的分类。core 重试倒计时（"N s 后重试"）算 transient，
 * 渲染为普通提示行，不弹操作按钮。
 */
export function classifyError(message: string): ErrorInfo {
  if (/后重试（第 \d+ 次）/.test(message)) {
    return { kind: "transient", hint: "", retryable: false, openSettings: false };
  }
  if (/\b(401|403)\b/.test(message)) {
    return {
      kind: "auth",
      hint: "API key 无效、过期或无权限。请到设置页检查该服务商的 key。",
      retryable: false,
      openSettings: true,
    };
  }
  if (/\b429\b/.test(message) || /限流|rate.?limit|quota/i.test(message)) {
    return {
      kind: "rate",
      hint: "服务商限流或额度不足：已自动重试仍失败，请稍后再试，或检查套餐余额。",
      retryable: true,
      openSettings: false,
    };
  }
  if (/网络错误|流中断|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|timed?out|证书|SSL|TLS/i.test(message)) {
    return {
      kind: "network",
      hint: "无法连接服务商：请检查本机网络或代理后重试。",
      retryable: true,
      openSettings: false,
    };
  }
  return { kind: "generic", hint: "", retryable: true, openSettings: false };
}

/**
 * AgentEvent → UI 状态。数组一律不可变替换（原地 push 不会被 React 感知，
 * 与 TUI <Static> 的 history 纪律同理）。
 */
export function applyEvent(state: UiState, ev: AgentEvent): UiState {
  switch (ev.type) {
    case "turn_start":
      // 关闭上一轮流式气泡：新一轮文本另起新气泡
      return { ...state, running: true, items: closeStreaming(state.items) };
    case "text_delta":
      return { ...state, items: appendDelta(state.items, ev.text) };
    case "tool_start":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "tool",
            id: ev.call.id,
            name: ev.call.name,
            input: ev.call.input,
            status: "running",
          },
        ],
      };
    case "tool_end":
      return {
        ...state,
        items: state.items.map((it): ChatItem =>
          it.kind === "tool" && it.id === ev.callId
            ? {
                ...it,
                status: ev.ok ? "ok" : "error",
                summary: ev.summary,
                durationMs: ev.durationMs,
              }
            : it,
        ),
      };
    case "usage":
      return { ...state, usage: ev.cumulative };
    case "error":
      return {
        ...state,
        items: [
          ...state.items,
          { kind: "notice", id: `notice-err-${state.items.length}`, level: "error", text: ev.message },
        ],
      };
    case "compacted":
      return {
        ...state,
        items: [
          ...state.items,
          { kind: "notice", id: `notice-info-${state.items.length}`, level: "info", text: ev.note },
        ],
      };
    case "todos_changed":
      return state; // demo 阶段不渲染 todo 卡片
    case "done":
      return { ...state, running: false, items: closeStreaming(state.items) };
    default: {
      const _exhaustive: never = ev;
      return state;
    }
  }
}

function appendDelta(items: ChatItem[], text: string): ChatItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === "assistant" && last.streaming) {
    return [...items.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [
    ...items,
    { kind: "assistant", id: `assistant-${items.length}`, text, streaming: true },
  ];
}

function closeStreaming(items: ChatItem[]): ChatItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === "assistant" && last.streaming) {
    return [...items.slice(0, -1), { ...last, streaming: false }];
  }
  return items;
}

export function addUserItem(state: UiState, text: string): UiState {
  return {
    ...state,
    items: [...state.items, { kind: "user", id: `user-${state.items.length}`, text }],
  };
}

export function pushPermission(state: UiState, ask: PermissionAsk): UiState {
  return {
    ...state,
    items: [
      ...state.items,
      {
        kind: "permission",
        id: ask.id,
        toolName: ask.toolName,
        input: ask.input,
        patterns: ask.patterns,
      },
    ],
  };
}

export function decidePermission(
  state: UiState,
  id: string,
  decision: PermissionDecision,
): UiState {
  return {
    ...state,
    items: state.items.map((it): ChatItem =>
      it.kind === "permission" && it.id === id ? { ...it, decided: decision } : it,
    ),
  };
}

/** 工具卡片参数摘要：取常见键的首个字符串值，压成单行 */
export function summarizeInput(input: unknown): string {
  if (typeof input === "string") return truncateOneLine(input);
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "command", "pattern", "query"]) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0) return truncateOneLine(v);
  }
  return "";
}

function truncateOneLine(s: string): string {
  const one = s.replace(/\s+/g, " ");
  return one.length > 64 ? `${one.slice(0, 61)}…` : one;
}
