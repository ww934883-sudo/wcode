import type { Message } from "../types";

/** 粗略 token 估算：中英混排约 3 字符/token（偏保守，够触发判断用） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** 整个消息历史的 token 估算（含工具调用参数摘要） */
export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    if (m.role === "user") {
      total += estimateTokens(m.content);
    } else if (m.role === "assistant") {
      total += estimateTokens(m.text);
      for (const c of m.toolCalls) {
        total += estimateTokens(toolInputPreview(c.input, 2000));
      }
    } else {
      for (const r of m.results) total += estimateTokens(r.content);
    }
  }
  return total;
}

function toolInputPreview(input: unknown, maxChars = 400): string {
  let s: string;
  try {
    s = JSON.stringify(input) ?? "null";
  } catch {
    s = String(input);
  }
  return s.length > maxChars ? s.slice(0, maxChars) + "…" : s;
}

/** 把归一化消息渲染成供摘要模型阅读的文本（每条截断，控住摘要输入体积） */
export function renderConversationForSummary(
  messages: Message[],
  maxItemChars = 300,
): string {
  const clip = (s: string): string =>
    s.length > maxItemChars ? s.slice(0, maxItemChars) + "…" : s;

  return messages
    .map((m) => {
      if (m.role === "user") return `[用户] ${clip(m.content)}`;
      if (m.role === "assistant") {
        const calls = m.toolCalls
          .map((c) => `调用工具 ${c.name}(${toolInputPreview(c.input, 200)})`)
          .join("；");
        const parts = [m.text && `[助手] ${clip(m.text)}`, calls && `[助手] ${calls}`];
        return parts.filter(Boolean).join("\n") || "[助手] (空回复)";
      }
      const results = m.results
        .map((r) => `[工具结果${r.isError ? "（错误）" : ""}] ${clip(r.content)}`)
        .join("\n");
      return results || "[工具结果] (空)";
    })
    .join("\n");
}

export const SUMMARY_SYSTEM_PROMPT =
  "你是编程 Agent 会话的摘要器。把给定的对话历史压缩成结构化摘要，供后续会话以此为基础继续任务。" +
  "只输出摘要本身（markdown），不要评论。必须包含以下小节（无内容的写「无」）：\n" +
  "## 任务目标\n## 已完成（含改动过的文件与关键结论）\n## 进行中\n## 待办\n" +
  "## 关键文件与路径\n## 用户的重要要求与偏好\n## 踩过的坑";

export function buildSummaryPrompt(rendered: string): string {
  return (
    "以下是一次编程任务的对话历史。请按系统要求输出结构化摘要，" +
    "保留一切继续任务所需的事实（文件路径、命令、结论、用户偏好），丢弃过程细节。\n\n" +
    `<conversation>\n${rendered}\n</conversation>`
  );
}
