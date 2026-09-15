import type { Message } from "../types";

export interface MicroCleanOptions {
  /** 保留最近 N 条 tool_result 原文，更早的大输出替换为占位符 */
  keepLastRounds?: number;
  /** 低于该字符数的输出不动 */
  minChars?: number;
}

/**
 * 工具结果微清理（架构文档 §4 上下文管理·第一层）：
 * 历史中较老的大体积 tool_result 替换为占位符，保留最近 N 条原文。
 * 零成本、收益最大；不修改原数组（不可变替换，请求侧拷贝）。
 */
export function microCleanMessages(
  messages: Message[],
  opts: MicroCleanOptions = {},
): Message[] {
  const keepLastRounds = opts.keepLastRounds ?? 2;
  const minChars = opts.minChars ?? 500;

  const toolResultIdx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "tool_result") toolResultIdx.push(i);
  });
  const keepSet = new Set(toolResultIdx.slice(-keepLastRounds));

  return messages.map((m, i) => {
    if (m.role !== "tool_result" || keepSet.has(i)) return m;
    const results = m.results.map((r) =>
      r.content.length >= minChars
        ? {
            ...r,
            content: `[工具输出已清理以节省上下文（原约 ${r.content.length} 字符）。如需再次查看请重新调用对应工具。]`,
          }
        : r,
    );
    return { role: "tool_result" as const, results };
  });
}
