import { describe, expect, it } from "vitest";
import type { Message } from "@wcode/core";
import {
  addUserItem,
  applyEvent,
  emptyUiState,
  itemsFromMessages,
  summarizeInput,
} from "./state";

describe("桌面渲染层事件归约", () => {
  it("text_delta 追加为流式气泡，且不可变替换", () => {
    const s1 = applyEvent(emptyUiState, { type: "text_delta", text: "你" });
    const s2 = applyEvent(s1, { type: "text_delta", text: "好" });
    expect(s2.items).toHaveLength(1);
    expect(s2.items[0]).toMatchObject({ kind: "assistant", text: "你好" });
    // 不可变：旧状态未被改动
    expect(s1.items[0]).toMatchObject({ text: "你" });
  });

  it("新一轮 turn_start 另起新气泡，不与上一轮拼接", () => {
    let s = applyEvent(emptyUiState, { type: "text_delta", text: "第一轮" });
    s = applyEvent(s, { type: "turn_start", turn: 2 });
    s = applyEvent(s, { type: "text_delta", text: "第二轮" });
    expect(s.items).toHaveLength(2);
    expect(s.items[1]).toMatchObject({ kind: "assistant", text: "第二轮" });
  });

  it("工具 start→end 更新同一张卡片", () => {
    let s = applyEvent(emptyUiState, {
      type: "tool_start",
      call: { id: "t1", name: "read", input: { file_path: "a.md" } },
    });
    s = applyEvent(s, {
      type: "tool_end",
      callId: "t1",
      toolName: "read",
      ok: true,
      summary: "12 行",
      durationMs: 3,
    });
    expect(s.items[0]).toMatchObject({ kind: "tool", status: "ok", summary: "12 行" });
  });

  it("done 关闭流式并复位 running", () => {
    let s = applyEvent(emptyUiState, { type: "text_delta", text: "hi" });
    s = applyEvent(s, { type: "turn_start", turn: 1 });
    expect(s.running).toBe(true);
    s = applyEvent(s, { type: "done", reason: "end_turn" });
    expect(s.running).toBe(false);
    expect(s.items[0]).toMatchObject({ streaming: false });
  });

  it("error 事件落为 notice 条目", () => {
    const s = applyEvent(emptyUiState, { type: "error", message: "请求失败" });
    expect(s.items[0]).toMatchObject({ kind: "notice", level: "error", text: "请求失败" });
  });

  it("用户消息与参数摘要", () => {
    const s = addUserItem(emptyUiState, "你好");
    expect(s.items[0]).toMatchObject({ kind: "user", text: "你好" });
    expect(summarizeInput({ file_path: "D:/a/b.md" })).toBe("D:/a/b.md");
    expect(summarizeInput("一段自由文本")).toBe("一段自由文本");
    expect(summarizeInput({ unknown_key: 1 })).toBe("");
  });

  it("历史会话水合：Message[] → 聊天项，工具结果回填卡片", () => {
    const messages: Message[] = [
      { role: "user", content: "读一下 README" },
      {
        role: "assistant",
        text: "好的。",
        toolCalls: [{ id: "t1", name: "read", input: { file_path: "README.md" } }],
      },
      {
        role: "tool_result",
        results: [{ callId: "t1", content: "# demo", isError: false }],
      },
      { role: "assistant", text: "内容是 demo。", toolCalls: [] },
    ];
    const items = itemsFromMessages(messages);
    expect(items.map((i) => i.kind)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(items[2]).toMatchObject({ kind: "tool", name: "read", status: "ok", summary: "# demo" });
  });

  it("历史会话水合：工具失败标记 error，孤立结果也有卡片", () => {
    const messages: Message[] = [
      {
        role: "tool_result",
        results: [{ callId: "ghost", content: "boom", isError: true }],
      },
    ];
    const items = itemsFromMessages(messages);
    expect(items[0]).toMatchObject({ kind: "tool", status: "error", summary: "boom" });
  });
});
