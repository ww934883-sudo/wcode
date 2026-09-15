import { describe, expect, it } from "vitest";
import { OpenAIChatProvider, toChatMessages } from "./openai-chat-provider";
import type { Message, ModelRequest, ToolDef } from "@wcode/core";

function sseResponse(sse: string, status = 200): Response {
  return new Response(status === 200 ? sse : JSON.stringify({ error: { message: sse } }), {
    status,
    headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" },
  });
}

const baseReq = (messages: Message[] = [], tools: ToolDef[] = []): ModelRequest => ({
  system: "sys",
  messages,
  tools,
  maxTokens: 1024,
  signal: new AbortController().signal,
});

async function collect(provider: OpenAIChatProvider, req: ModelRequest) {
  const events: Array<{
    type: string;
    text?: string;
    response?: {
      stopReason: string;
      text: string;
      toolCalls: Array<{ id: string; name: string; input: unknown }>;
      usage: { inputTokens: number; outputTokens: number };
    };
  }> = [];
  for await (const ev of provider.stream(req)) events.push(ev);
  return events;
}

describe("OpenAIChatProvider 契约", () => {
  it("解析文本流与 usage，产出归一化事件", async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"你好"}}]}',
      "",
      'data: {"choices":[{"index":0,"delta":{"content":"!"}}]}',
      "",
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "",
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const provider = new OpenAIChatProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: (async () => sseResponse(sse)) as typeof fetch,
    });
    const events = await collect(provider, baseReq());

    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual(["你好", "!"]);
    const final = events[events.length - 1]!;
    expect(final.type).toBe("message_complete");
    expect(final.response!.stopReason).toBe("end_turn");
    expect(final.response!.text).toBe("你好!");
    expect(final.response!.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it("解析增量 tool_calls（分片 arguments 按 index 拼接）", async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":""}}]}}]}',
      "",
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"file_path\\":"}}]}}]}',
      "",
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}',
      "",
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":20,"completion_tokens":9}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const provider = new OpenAIChatProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: (async () => sseResponse(sse)) as typeof fetch,
    });
    const events = await collect(provider, baseReq());
    const final = events[events.length - 1]!;
    expect(final.response!.stopReason).toBe("tool_use");
    expect(final.response!.toolCalls).toEqual([
      { id: "call_1", name: "read", input: { file_path: "a.txt" } },
    ]);
    expect(final.response!.usage).toEqual({ inputTokens: 20, outputTokens: 9 });
  });

  it("finish_reason=length 映射为 max_tokens；损坏 JSON 参数回退空对象", async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c2","function":{"name":"edit","arguments":"{broken"}}]}}]}',
      "",
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const provider = new OpenAIChatProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: (async () => sseResponse(sse)) as typeof fetch,
    });
    const events = await collect(provider, baseReq());
    const final = events[events.length - 1]!;
    expect(final.response!.stopReason).toBe("max_tokens");
    expect(final.response!.toolCalls[0]!.input).toEqual({});
  });

  it("429 映射为可重试，401 映射为不可重试", async () => {
    const provider = new OpenAIChatProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: (async () => sseResponse("rate limited", 429)) as typeof fetch,
    });
    await expect(async () => {
      for await (const _ev of provider.stream(baseReq())) {
        /* 期待抛错 */
      }
    }).rejects.toMatchObject({ retryable: true, status: 429 });

    const provider2 = new OpenAIChatProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: (async () => sseResponse("bad key", 401)) as typeof fetch,
    });
    await expect(async () => {
      for await (const _ev of provider2.stream(baseReq())) {
        /* 期待抛错 */
      }
    }).rejects.toMatchObject({ retryable: false, status: 401 });
  });

  describe("toChatMessages", () => {
    it("system 置首；assistant 带 tool_calls；tool_result 逐条映射 role:tool", () => {
      const wire = toChatMessages(
        [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            text: "看一下",
            toolCalls: [
              { id: "a", name: "read", input: { file_path: "a.txt" } },
              { id: "b", name: "read", input: {} },
            ],
          },
          { role: "tool_result", results: [{ callId: "a", content: "ok", isError: false }] },
          { role: "tool_result", results: [{ callId: "b", content: "坏了", isError: true }] },
        ],
        "系统提示",
      );
      expect(wire).toHaveLength(5);
      expect(wire[0]).toEqual({ role: "system", content: "系统提示" });
      expect(wire[1]).toEqual({ role: "user", content: "hi" });
      const assistant = wire[2] as {
        role: string;
        content: string | null;
        tool_calls: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
      expect(assistant.content).toBe("看一下");
      expect(assistant.tool_calls).toHaveLength(2);
      expect(assistant.tool_calls[0]!.function).toEqual({
        name: "read",
        arguments: '{"file_path":"a.txt"}',
      });
      expect(wire[3]).toEqual({ role: "tool", tool_call_id: "a", content: "ok" });
      const failed = wire[4] as { role: string; tool_call_id: string; content: string };
      expect(failed.tool_call_id).toBe("b");
      expect(failed.content).toContain("工具调用失败");
      expect(failed.content).toContain("坏了");
    });

    it("tool_result 携带 images 时显式告知模型（协议不支持工具图片）", () => {
      const wire = toChatMessages(
        [
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
        ],
        "",
      );
      const tool = wire[2] as { role: string; content: string };
      expect(tool.content).toContain("1 张图片");
    });
  });
});
