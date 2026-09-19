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
  /** 本轮开始时刻（epoch ms）。turn_start 在工具循环里每轮都发，只在 false→true 时捕获一次 */
  runningSince: number | null;
  /** 划选引用（补充上下文）：挂在输入框上方，发送时并入消息文本 */
  quotes: QuoteItem[];
  /** 附件（+ 选择文件 / 粘贴长文转存）：发送时经主进程以标注块进入模型上下文 */
  attachments: AttachmentItem[];
}

export const emptyUiState: UiState = {
  items: [],
  usage: null,
  running: false,
  runningSince: null,
  quotes: [],
  attachments: [],
};

// ── 划选引用（补充上下文）──
// 上限刻意保守：引用是「指哪段」的锚点，不是内容搬运工具；超限直接报错不截断
export const QUOTE_MAX_CHARS = 2000;
export const QUOTE_MAX_COUNT = 5;

export interface QuoteItem {
  id: string;
  text: string;
}

/** 追加划选引用：超限返回教学式错误（说清现状与出路），已有引用与草稿不受影响 */
export function addQuote(
  quotes: QuoteItem[],
  text: string,
): { ok: true; quotes: QuoteItem[] } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: "选区内容为空，无法添加为引用。" };
  if (trimmed.length > QUOTE_MAX_CHARS) {
    return {
      ok: false,
      error: `引用过长（${trimmed.length} 字，上限 ${QUOTE_MAX_CHARS} 字）。请缩小选区范围；内容不会自动截断。`,
    };
  }
  if (quotes.length >= QUOTE_MAX_COUNT) {
    return {
      ok: false,
      error: `引用已达上限（${QUOTE_MAX_COUNT} 条）。可先移除输入框上方的已有引用再添加。`,
    };
  }
  return {
    ok: true,
    quotes: [...quotes, { id: `quote-${Date.now()}-${quotes.length}`, text: trimmed }],
  };
}

/** 发送时引用并入消息文本：blockquote 前置，用户气泡与模型上下文看到同一段内容 */
export function composeWithQuotes(quotes: QuoteItem[], text: string): string {
  if (quotes.length === 0) return text;
  const quoted = quotes.map((q) => "> " + q.text.replace(/\n/g, "\n> ")).join("\n\n");
  return `[引用上方对话片段]\n${quoted}\n\n${text}`;
}

// ── 附件（补充上下文）──
// 粘贴长文自动转附件的阈值：超过则整段转存，输入框只留附件条目不刷屏
export const PASTE_TO_ATTACHMENT_CHARS = 2000;
export const ATTACHMENT_MAX_COUNT = 5;

export interface AttachmentItem {
  id: string;
  name: string;
  kind: "file" | "text";
  /** kind=file：绝对路径，主进程发送时读取 */
  path?: string;
  /** kind=text：粘贴的完整内容 */
  content?: string;
}

/** 磁盘路径 → 附件条目（名称取 basename，Windows 反斜杠一并兼容） */
export function fileAttachmentsFromPaths(paths: string[]): AttachmentItem[] {
  return paths.map((p, i) => ({
    id: `att-${Date.now()}-${i}`,
    name: p.split(/[\\/]/).pop() || p,
    kind: "file" as const,
    path: p,
  }));
}

/** 粘贴长文 → 附件条目：名称带字数，chip 上一眼能看出是什么 */
export function textAttachmentFromPaste(text: string): AttachmentItem {
  const trimmed = text.trim();
  return {
    id: `att-${Date.now()}-paste`,
    name: `粘贴的文本（${trimmed.length} 字）`,
    kind: "text",
    content: text,
  };
}

/** 追加附件：全有或全无——超限整批拒绝并报教学式错误，已有附件不受影响 */
export function addAttachments(
  existing: AttachmentItem[],
  incoming: AttachmentItem[],
): { ok: true; attachments: AttachmentItem[] } | { ok: false; error: string } {
  if (incoming.length === 0) return { ok: true, attachments: existing };
  const total = existing.length + incoming.length;
  if (total > ATTACHMENT_MAX_COUNT) {
    return {
      ok: false,
      error: `附件将达 ${total} 个，超出上限（${ATTACHMENT_MAX_COUNT} 个）。请减少数量，或先移除输入框上方的已有附件。`,
    };
  }
  return { ok: true, attachments: [...existing, ...incoming] };
}

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
      return {
        ...state,
        running: true,
        runningSince: state.running ? state.runningSince : Date.now(),
        items: closeStreaming(state.items),
      };
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
      return {
        ...state,
        running: false,
        runningSince: null,
        // 中止时挂起询问已在管道侧以 deny 解除：未决权限卡片随之落定，不留可点的死卡片
        items: closePendingAsks(closeStreaming(state.items)),
      };
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
  // 工具卡片会插在文本气泡之后，只关最后一条会把光标留在前几轮气泡里
  return items.map((it): ChatItem =>
    it.kind === "assistant" && it.streaming ? { ...it, streaming: false } : it,
  );
}

function closePendingAsks(items: ChatItem[]): ChatItem[] {
  return items.map((it): ChatItem =>
    it.kind === "permission" && it.decided === undefined ? { ...it, decided: "deny" } : it,
  );
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
