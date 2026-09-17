import type {
  Message,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StreamEvent,
  ThinkingLevel,
  ToolCall,
  ToolDef,
} from "@wcode/core";
import { AbortedError, isAbortedError, ProviderError } from "@wcode/core";
import { describe, iterateSseData, toOpenAIProviderError } from "./sse";

export interface OpenAIChatProviderOptions {
  apiKey: string;
  model: string;
  /** 默认 https://api.openai.com/v1；DeepSeek/Qwen/GLM/Kimi 等指向各自 /v1 */
  baseUrl?: string;
  maxTokens?: number;
  /** 测试注入 mock fetch */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * 思考级别 → Chat Completions 的 reasoning_effort（o 系/gpt-5 及兼容网关）。
 * off/undefined 不传该字段——部分兼容网关对未知枚举直接 400，
 * 不做「都发出去」的乐观透传。
 */
export function reasoningEffort(
  level: ThinkingLevel | undefined,
): "low" | "medium" | "high" | undefined {
  return level && level !== "off" ? level : undefined;
}

/**
 * OpenAI Chat Completions 协议适配（/chat/completions）。
 * 归一化类型 ↔ 线格式翻译 + SSE 流解析；思维链字段不回传；
 * 错误只翻译成 ProviderError{retryable}，重试节奏由 core 决定。
 */
export class OpenAIChatProvider implements ModelProvider {
  readonly id = "openai-chat";
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIChatProviderOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.maxTokens = opts.maxTokens ?? 8192;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toChatMessages(req.messages, req.system),
      max_tokens: Math.min(req.maxTokens, this.maxTokens),
      stream: true,
      // 让服务端在流末尾单独发 usage 块（部分网关缺省不发）
      stream_options: { include_usage: true },
    };
    const effort = reasoningEffort(req.thinking);
    if (effort) body.reasoning_effort = effort;
    if (req.tools.length > 0) {
      body.tools = toChatTools(req.tools);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      if (isAbortedError(err) || req.signal.aborted) throw new AbortedError();
      throw new ProviderError(`网络错误: ${describe(err)}`, { retryable: true });
    }

    if (!res.ok) throw await toOpenAIProviderError(res, "OpenAI Chat API");

    let text = "";
    let stopReason: ModelResponse["stopReason"] = "end_turn";
    let usage = { inputTokens: 0, outputTokens: 0 };
    // index → 进行中的 tool_call（arguments 分片累加）
    const toolAcc = new Map<number, { id: string; name: string; json: string }>();

    const handlePayload = (payloadStr: string): StreamEvent | null => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(payloadStr) as Record<string, unknown>;
      } catch {
        return null; // 忽略不可解析的行
      }
      const chunkUsage = payload.usage as
        | { prompt_tokens?: number; completion_tokens?: number }
        | undefined;
      if (chunkUsage) {
        usage.inputTokens = chunkUsage.prompt_tokens ?? usage.inputTokens;
        usage.outputTokens = chunkUsage.completion_tokens ?? usage.outputTokens;
      }
      const choices = payload.choices as
        | Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>
        | undefined;
      const choice = choices?.[0];
      if (choice?.delta?.content) {
        text += choice.delta.content;
        return { type: "text_delta", text: choice.delta.content };
      }
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const acc = toolAcc.get(tc.index) ?? { id: "", name: "", json: "" };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.json += tc.function.arguments;
        toolAcc.set(tc.index, acc);
      }
      if (choice?.finish_reason) {
        if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
        else if (choice.finish_reason === "length") stopReason = "max_tokens";
        else stopReason = "end_turn";
      }
      return null;
    };

    try {
      for await (const data of iterateSseData(res, req.signal)) {
        const ev = handlePayload(data);
        if (ev) yield ev;
      }
    } catch (err) {
      if (isAbortedError(err) || req.signal.aborted) throw new AbortedError();
      throw err;
    }

    const toolCalls: ToolCall[] = [...toolAcc.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, b]) => {
        let input: unknown;
        try {
          input = b.json ? (JSON.parse(b.json) as unknown) : {};
        } catch {
          // 交给 core 的 schema 校验生成教学式报错，模型可自纠
          input = {};
        }
        return { id: b.id, name: b.name, input };
      });

    yield {
      type: "message_complete",
      response: { stopReason, text, toolCalls, usage },
    };
  }

  /** GET /models；status 标记为 Shutdown（已下线）的条目过滤掉 */
  async listModels(): Promise<string[]> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) throw await toOpenAIProviderError(res, "OpenAI Chat API");
      const data = (await res.json()) as {
        data?: Array<{ id?: string; status?: string }>;
      };
      return (data.data ?? [])
        .filter((m) => m.id && m.status !== "Shutdown")
        .map((m) => m.id as string);
    } catch (err) {
      if (isAbortedError(err)) throw new AbortedError();
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(`listModels 失败: ${describe(err)}`, { retryable: true });
    }
  }

  /**
   * OpenAI 无计数端点：按 chars/3 估算（core 的 compact 阈值本就用同款估算，
   * 精度一致，不会造成行为差异）。
   */
  async countTokens(messages: Message[]): Promise<number> {
    const chars = messages.reduce((sum, m) => {
      if (m.role === "assistant") return sum + m.text.length;
      if (m.role === "tool_result") {
        return sum + m.results.reduce((s, r) => s + r.content.length, 0);
      }
      return sum + m.content.length;
    }, 0);
    return Math.ceil(chars / 3);
  }
}

/** 归一化消息 → Chat Completions 线格式；每个 tool_result 一条 role:"tool" 消息 */
export function toChatMessages(
  messages: Message[],
  system: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (system.trim()) out.push({ role: "system", content: system });

  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.text || null,
        ...(m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.input ?? {}),
                },
              })),
            }
          : {}),
      });
    } else {
      for (const r of m.results) {
        // 工具消息只支持文本；图像结果无法承载，显式告知模型而非静默丢弃
        const note = r.images?.length
          ? `${r.content}\n[注意: ${r.images.length} 张图片结果在当前协议下无法返回]`
          : r.content;
        out.push({
          role: "tool",
          tool_call_id: r.callId,
          content: r.isError ? `工具调用失败：${note}` : note,
        });
      }
    }
  }
  return out;
}

function toChatTools(tools: ToolDef[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}
