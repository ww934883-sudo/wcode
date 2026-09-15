import { describe, expect, it } from "vitest";
import { AnthropicProvider, toAnthropicMessages } from "./anthropic-provider";
import type { Message, ModelRequest } from "@wcode/core";

function sseResponse(sse: string, status = 200): Response {
  return new Response(status === 200 ? sse : JSON.stringify({ error: { message: sse } }), {
    status,
    headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" },
  });
}

const baseReq = (messages: Message[] = []): ModelRequest => ({
  system: "sys",
  messages,
  tools: [],
  maxTokens: 1024,
  signal: new AbortController().signal,
});

describe("AnthropicProvider 契约", () => {
  it("解析文本流并产出归一化事件", async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":11}}}',
      "",
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"!"}}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");

    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: (async () => sseResponse(sse)) as typeof fetch,
    });
    const events = [];
    for await (const ev of provider.stream(baseReq())) events.push(ev);

    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text)).toEqual(["你好", "!"]);
    const final = events[events.length - 1] as { type: string; response: { stopReason: string; text: string; usage: { inputTokens: number; outputTokens: number } } };
    expect(final.type).toBe("message_complete");
    expect(final.response.stopReason).toBe("end_turn");
    expect(final.response.text).toBe("你好!");
    expect(final.response.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it("解析 tool_use 块（含 input_json_delta 拼接）", async () => {
    const sse = [
      "event: message_start",
      'data: {"type":"message_start","message":{"usage":{"input_tokens":20}}}',
      "",
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"read"}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":"}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a.txt\\"}"}}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: (async () => sseResponse(sse)) as typeof fetch,
    });
    let final: { response: { stopReason: string; toolCalls: Array<{ id: string; name: string; input: unknown }> } } | undefined;
    for await (const ev of provider.stream(baseReq())) {
      if (ev.type === "message_complete") final = ev;
    }
    expect(final?.response.stopReason).toBe("tool_use");
    expect(final?.response.toolCalls).toEqual([
      { id: "t1", name: "read", input: { file_path: "a.txt" } },
    ]);
  });

  it("429 映射为可重试，401 映射为不可重试", async () => {
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: (async (_url: string, init?: RequestInit) =>
        sseResponse("rate limited", 429)) as unknown as typeof fetch,
    });
    await expect(async () => {
      for await (const _ev of provider.stream(baseReq())) {
        /* 期待抛错 */
      }
    }).rejects.toMatchObject({ retryable: true, status: 429 });

    const provider2 = new AnthropicProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: (async () => sseResponse("bad key", 401)) as unknown as typeof fetch,
    });
    await expect(async () => {
      for await (const _ev of provider2.stream(baseReq())) {
        /* 期待抛错 */
      }
    }).rejects.toMatchObject({ retryable: false, status: 401 });
  });

  describe("toAnthropicMessages", () => {
    it("连续 tool_result 合并进一条 user 消息并标记 is_error", () => {
      const wire = toAnthropicMessages([
        { role: "user", content: "hi" },
        { role: "assistant", text: "", toolCalls: [{ id: "a", name: "read", input: {} }, { id: "b", name: "read", input: {} }] },
        { role: "tool_result", results: [{ callId: "a", content: "ok", isError: false }] },
        { role: "tool_result", results: [{ callId: "b", content: "bad", isError: true }] },
      ]);
      expect(wire).toHaveLength(3);
      expect(wire[0]).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
      const assistant = wire[1] as { role: string; content: Array<{ type: string }> };
      expect(assistant.content.map((c) => c.type)).toEqual(["tool_use", "tool_use"]);
      const user = wire[2] as { role: string; content: Array<Record<string, unknown>> };
      expect(user.role).toBe("user");
      expect(user.content).toHaveLength(2);
      expect(user.content[1]?.is_error).toBe(true);
    });

    it("tool_result 携带 images 时映射为 base64 图像块", () => {
      const wire = toAnthropicMessages([
        { role: "user", content: "看图" },
        { role: "assistant", text: "", toolCalls: [{ id: "a", name: "read", input: {} }] },
        {
          role: "tool_result",
          results: [
            {
              callId: "a",
              content: "[图片已返回]",
              isError: false,
              images: [{ type: "image", mediaType: "image/png", data: "aGk=" }],
            },
          ],
        },
      ]);
      const user = wire[2] as { role: string; content: Array<Record<string, unknown>> };
      const tr = user.content[0] as {
        type: string;
        content: Array<Record<string, unknown>>;
      };
      expect(tr.type).toBe("tool_result");
      expect(tr.content[0]?.type).toBe("text");
      expect(tr.content[1]?.type).toBe("image");
      expect(tr.content[1]?.source).toEqual({
        type: "base64",
        media_type: "image/png",
        data: "aGk=",
      });
    });
  });
});
