import { describe, expect, it } from "vitest";
import { AnthropicProvider, toAnthropicMessages } from "./anthropic-provider";
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

  describe("listModels", () => {
    it("GET /v1/models 单页取全并解析 id 列表", async () => {
      let calledUrl = "";
      const provider = new AnthropicProvider({
        apiKey: "k",
        model: "m",
        fetchImpl: (async (url: string) => {
          calledUrl = url;
          return new Response(
            JSON.stringify({ data: [{ id: "claude-x" }, { id: "claude-y" }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as unknown as typeof fetch,
      });
      await expect(provider.listModels()).resolves.toEqual(["claude-x", "claude-y"]);
      expect(calledUrl).toContain("/v1/models?limit=1000");
    });

    it("网关不支持（401）→ ProviderError 不可重试", async () => {
      const provider = new AnthropicProvider({
        apiKey: "k",
        model: "m",
        fetchImpl: (async () => sseResponse("unauthorized", 401)) as unknown as typeof fetch,
      });
      await expect(provider.listModels()).rejects.toMatchObject({
        retryable: false,
        status: 401,
      });
    });

    it("Anthropic /v1/models 401 → 降级 Bearer /v3/models（火山 coding 实测形态）", async () => {
      const calls: Array<{ url: string; auth?: string; apiKey?: string }> = [];
      const provider = new AnthropicProvider({
        apiKey: "k",
        model: "m",
        baseUrl: "https://ark.example.com/api/coding",
        fetchImpl: (async (url: string, init?: RequestInit) => {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          calls.push({
            url,
            auth: headers.authorization,
            apiKey: headers["x-api-key"],
          });
          if (url.includes("/v1/models")) {
            return new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
              status: 401,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({
              data: [{ id: "glm-5.3-flash" }, { id: "doubao-seed-x" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as unknown as typeof fetch,
      });
      await expect(provider.listModels()).resolves.toEqual([
        "glm-5.3-flash",
        "doubao-seed-x",
      ]);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.url).toContain("/v1/models");
      expect(calls[0]?.apiKey).toBe("k");
      expect(calls[1]?.url).toContain("/v3/models");
      expect(calls[1]?.auth).toBe("Bearer k");
    });
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

describe("思考级别映射", () => {
  const minimalSse = 'data: {"type":"message_stop"}\n\n';
  async function capturedBody(
    thinking: ThinkingLevel | undefined,
  ): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sseResponse(minimalSse);
      }) as typeof fetch,
    });
    for await (const _ev of provider.stream({ ...baseReq(), thinking })) {
      /* 消费即触发请求 */
    }
    return body;
  }

  it("off/缺省不携带 thinking 字段", async () => {
    expect(await capturedBody(undefined)).not.toHaveProperty("thinking");
    expect(await capturedBody("off")).not.toHaveProperty("thinking");
  });

  it("low/medium/high 映射为递增预算，max_tokens 自动抬到预算之上", async () => {
    const low = await capturedBody("low");
    expect(low.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(low.max_tokens).toBe(5120); // 4096 + 1024
    const medium = await capturedBody("medium");
    expect(medium.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
    expect(medium.max_tokens).toBe(17408);
    const high = await capturedBody("high");
    expect(high.thinking).toEqual({ type: "enabled", budget_tokens: 32768 });
    expect(high.max_tokens).toBe(33792);
  });
});

describe("思考能力声明", () => {
  it("thinkingLevels 按模型族收敛：3.7 之前不支持，3.7+/4 系与未知模型全档", () => {
    const levels = (model: string) =>
      new AnthropicProvider({ apiKey: "k", model }).thinkingLevels();
    expect(levels("claude-3-5-sonnet-20241022")).toEqual([]);
    expect(levels("claude-3-opus-20240229")).toEqual([]);
    expect(levels("claude-2.1")).toEqual([]);
    expect(levels("claude-3-7-sonnet-20250219")).toEqual(["off", "low", "medium", "high"]);
    expect(levels("claude-sonnet-4-5")).toEqual(["off", "low", "medium", "high"]);
    // 火山等兼容层的自定义模型名按支持处理（与未做能力判断前的行为一致）
    expect(levels("glm-4.6")).toEqual(["off", "low", "medium", "high"]);
  });

  it("不支持的模型即使请求 thinking: high 也不发 thinking 字段", async () => {
    let body: Record<string, unknown> = {};
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-3-5-haiku-20241022",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sseResponse('data: {"type":"message_stop"}\n\n');
      }) as typeof fetch,
    });
    for await (const _ev of provider.stream({ ...baseReq(), thinking: "high" })) {
      /* 消费即触发请求 */
    }
    expect(body).not.toHaveProperty("thinking");
  });
});
