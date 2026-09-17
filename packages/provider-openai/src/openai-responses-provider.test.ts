import { describe, expect, it } from "vitest";
import { OpenAIResponsesProvider, toResponsesInput } from "./openai-responses-provider";
import type { Message, ModelRequest, ThinkingLevel } from "@wcode/core";

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

async function collect(provider: OpenAIResponsesProvider, req: ModelRequest) {
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

describe("OpenAIResponsesProvider 契约", () => {
  it("output_text.delta 转发文本增量，completed 载荷为最终响应", async () => {
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"你好"}',
      "",
      'data: {"type":"response.output_text.delta","delta":"!"}',
      "",
      'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"你好!"}]}],"usage":{"input_tokens":11,"output_tokens":7}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const provider = new OpenAIResponsesProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: (async () => sseResponse(sse)) as typeof fetch,
    });
    const events = await collect(provider, baseReq());

    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual(["你好", "!"]);
    const final = events[events.length - 1]!;
    expect(final.response!.stopReason).toBe("end_turn");
    expect(final.response!.text).toBe("你好!");
    expect(final.response!.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it("function_call 输出项映射为 toolCalls（含 JSON 参数解析）", async () => {
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"查一下"}',
      "",
      'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","call_id":"call_9","name":"read","arguments":"{\\"file_path\\":\\"a.txt\\"}"}],"usage":{"input_tokens":20,"output_tokens":9}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const provider = new OpenAIResponsesProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: (async () => sseResponse(sse)) as typeof fetch,
    });
    const events = await collect(provider, baseReq());
    const final = events[events.length - 1]!;
    expect(final.response!.stopReason).toBe("tool_use");
    expect(final.response!.toolCalls).toEqual([
      { id: "call_9", name: "read", input: { file_path: "a.txt" } },
    ]);
  });

  it("incomplete + max_output_tokens 映射为 max_tokens；failed 抛不可重试错误", async () => {
    const incomplete = [
      'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"写到一半"}]}],"usage":{"input_tokens":5,"output_tokens":1024}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const provider = new OpenAIResponsesProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: (async () => sseResponse(incomplete)) as typeof fetch,
    });
    const events = await collect(provider, baseReq());
    const final = events[events.length - 1]!;
    expect(final.response!.stopReason).toBe("max_tokens");
    expect(final.response!.text).toBe("写到一半");

    const failed = [
      'data: {"type":"response.failed","response":{"status":"failed","error":{"message":"内部错误"}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const provider2 = new OpenAIResponsesProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: (async () => sseResponse(failed)) as typeof fetch,
    });
    await expect(async () => {
      for await (const _ev of provider2.stream(baseReq())) {
        /* 期待抛错 */
      }
    }).rejects.toMatchObject({ retryable: false });
  });

  it("401 映射为不可重试", async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: (async () => sseResponse("bad key", 401)) as typeof fetch,
    });
    await expect(async () => {
      for await (const _ev of provider.stream(baseReq())) {
        /* 期待抛错 */
      }
    }).rejects.toMatchObject({ retryable: false, status: 401 });
  });

  describe("listModels", () => {
    it("GET /models（与 Chat 同目录端点）过滤 Shutdown", async () => {
      const provider = new OpenAIResponsesProvider({
        apiKey: "k",
        model: "m",
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              data: [{ id: "gpt-x" }, { id: "dead", status: "Shutdown" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as typeof fetch,
      });
      await expect(provider.listModels()).resolves.toEqual(["gpt-x"]);
    });
  });

  describe("toResponsesInput", () => {
    it("assistant 文本与 function_call 分列；tool_result 映射 function_call_output", () => {
      const input = toResponsesInput([
        { role: "user", content: "hi" },
        {
          role: "assistant",
          text: "看一下",
          toolCalls: [{ id: "a", name: "read", input: { file_path: "a.txt" } }],
        },
        { role: "tool_result", results: [{ callId: "a", content: "内容", isError: false }] },
      ]);
      expect(input).toHaveLength(4);
      expect(input[0]).toEqual({
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      });
      expect(input[1]).toEqual({
        role: "assistant",
        content: [{ type: "output_text", text: "看一下" }],
      });
      expect(input[2]).toEqual({
        type: "function_call",
        call_id: "a",
        name: "read",
        arguments: '{"file_path":"a.txt"}',
      });
      expect(input[3]).toEqual({
        type: "function_call_output",
        call_id: "a",
        output: "内容",
      });
    });
  });
});

describe("思考级别映射（reasoning.effort）", () => {
  const minimalSse = 'data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
  async function capturedBody(
    thinking: ThinkingLevel | undefined,
  ): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    const provider = new OpenAIResponsesProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sseResponse(minimalSse);
      }) as typeof fetch,
    });
    await collect(provider, { ...baseReq(), thinking });
    return body;
  }

  it("off/缺省不携带 reasoning", async () => {
    expect(await capturedBody(undefined)).not.toHaveProperty("reasoning");
    expect(await capturedBody("off")).not.toHaveProperty("reasoning");
  });

  it("low/medium/high 映射为 reasoning.effort", async () => {
    expect(await capturedBody("low")).toMatchObject({ reasoning: { effort: "low" } });
    expect(await capturedBody("medium")).toMatchObject({ reasoning: { effort: "medium" } });
    expect(await capturedBody("high")).toMatchObject({ reasoning: { effort: "high" } });
  });
});
