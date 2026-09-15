import { describe, expect, it } from "vitest";
import { microCleanMessages } from "./micro-clean";
import type { Message } from "../types";

function toolResult(content: string): Message {
  return { role: "tool_result", results: [{ callId: "c", content, isError: false }] };
}

describe("microCleanMessages", () => {
  it("较老的大输出替换为占位符，最近 2 条保留原文", () => {
    const messages: Message[] = [
      { role: "user", content: "task" },
      toolResult("X".repeat(2000)), // 老 → 清理
      { role: "assistant", text: "", toolCalls: [] },
      toolResult("Y".repeat(2000)), // 次新 → 清理
      toolResult("Z".repeat(2000)), // 最近 → 保留
      toolResult("small"), // 最近且小 → 保留
    ];
    const cleaned = microCleanMessages(messages);
    const results = cleaned
      .filter((m) => m.role === "tool_result")
      .map((m) => (m as Extract<Message, { role: "tool_result" }>).results[0]!.content);
    expect(results[0]).toContain("已清理");
    expect(results[1]).toContain("已清理");
    expect(results[1]).toContain("2000");
    expect(results[2]).toBe("Z".repeat(2000));
    expect(results[3]).toBe("small");
  });

  it("不修改原数组（不可变）", () => {
    const messages: Message[] = [toolResult("A".repeat(1000))];
    microCleanMessages(messages);
    const first = messages[0] as Extract<Message, { role: "tool_result" }>;
    expect(first.results[0]!.content).toBe("A".repeat(1000));
  });

  it("错误结果同样被清理（内容已进模型上下文过）", () => {
    const messages: Message[] = [
      { role: "tool_result", results: [{ callId: "c", content: "E".repeat(900), isError: true }] },
      toolResult("ok"),
      toolResult("ok2"),
    ];
    const cleaned = microCleanMessages(messages, { keepLastRounds: 2 });
    const first = cleaned[0] as Extract<Message, { role: "tool_result" }>;
    expect(first.results[0]!.content).toContain("已清理");
  });
});
