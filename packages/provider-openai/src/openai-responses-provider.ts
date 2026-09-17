import type {
  Message,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StreamEvent,
  ThinkingLevel,
  ToolCall,
  ToolDef,
  Usage,
} from "@wcode/core";
import { AbortedError, isAbortedError, ProviderError } from "@wcode/core";
import { describe, iterateSseData, toOpenAIProviderError } from "./sse";
import { reasoningEffort } from "./openai-chat-provider";

export interface OpenAIResponsesProviderOptions {
  apiKey: string;
  model: string;
  /** 默认 https://api.openai.com/v1 */
  baseUrl?: string;
  maxTokens?: number;
  /** 测试注入 mock fetch */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

interface OutputItem {
  type?: string;
  role?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
}

interface ResponsesPayload {
  response?: {
    output?: OutputItem[];
    usage?: { input_tokens?: number; output_tokens?: number };
    status?: string;
    incomplete_details?: { reason?: string };
    error?: { message?: string } | null;
  };
  delta?: string;
  item?: OutputItem;
}

/**
 * OpenAI Responses 协议适配（/responses）。
 * 流式增量只用于 text_delta 的实时上屏；最终 ModelResponse 以
 * response.completed 事件携带的完整 response 对象为准（单一致据源）。
 */
export class OpenAIResponsesProvider implements ModelProvider {
  readonly id = "openai-responses";
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIResponsesProviderOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.maxTokens = opts.maxTokens ?? 8192;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    const body: Record<string, unknown> = {
      model: this.model,
      instructions: req.system,
      input: toResponsesInput(req.messages),
      max_output_tokens: Math.min(req.maxTokens, this.maxTokens),
      stream: true,
    };
    // Responses 协议的思考参数是 reasoning:{effort}（与 Chat 的 reasoning_effort 同源映射）
    const effort = reasoningEffort(req.thinking);
    if (effort) body.reasoning = { effort };
    if (req.tools.length > 0) {
      body.tools = toResponsesTools(req.tools);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/responses`, {
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

    if (!res.ok) throw await toOpenAIProviderError(res, "OpenAI Responses API");

    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let status = "completed";
    let incompleteReason = "";
    let finalOutput: OutputItem[] | undefined;
    let failed = false;

    try {
      for await (const data of iterateSseData(res, req.signal)) {
        let payload: ResponsesPayload;
        try {
          payload = JSON.parse(data) as ResponsesPayload;
        } catch {
          continue;
        }
        const type = (payload as { type?: string }).type ?? "";
        if (type === "response.output_text.delta" && payload.delta) {
          yield { type: "text_delta", text: payload.delta };
        } else if (type === "response.completed") {
          finalOutput = payload.response?.output;
          usage = {
            inputTokens: payload.response?.usage?.input_tokens ?? 0,
            outputTokens: payload.response?.usage?.output_tokens ?? 0,
          };
          status = payload.response?.status ?? "completed";
          incompleteReason = payload.response?.incomplete_details?.reason ?? "";
        } else if (type === "response.incomplete") {
          finalOutput = payload.response?.output;
          usage = {
            inputTokens: payload.response?.usage?.input_tokens ?? 0,
            outputTokens: payload.response?.usage?.output_tokens ?? 0,
          };
          status = "incomplete";
          incompleteReason = payload.response?.incomplete_details?.reason ?? "";
        } else if (type === "response.failed") {
          failed = true;
          const message = payload.response?.error?.message ?? "response.failed";
          throw new ProviderError(`OpenAI Responses 流中错误: ${message}`, {
            retryable: false,
          });
        }
      }
    } catch (err) {
      if (isAbortedError(err) || req.signal.aborted) throw new AbortedError();
      throw err;
    }
    void failed;

    // 兜底：个别实现不发 completed/incomplete，从 output_item.done 累积
    // （finalOutput 优先，见 completed 分支；此处仅处理"两者皆无"的退化场景）
    const items = finalOutput ?? [];
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const item of items) {
      if (item.type === "message" || (!item.type && item.role === "assistant")) {
        for (const c of item.content ?? []) {
          if ((c.type === "output_text" || !c.type) && c.text) text += c.text;
        }
      } else if (item.type === "function_call") {
        let input: unknown;
        try {
          input = item.arguments ? (JSON.parse(item.arguments) as unknown) : {};
        } catch {
          // 交给 core 的 schema 校验生成教学式报错，模型可自纠
          input = {};
        }
        toolCalls.push({ id: item.call_id ?? "", name: item.name ?? "", input });
      }
    }

    const stopReason: ModelResponse["stopReason"] =
      toolCalls.length > 0
        ? "tool_use"
        : status === "incomplete" && incompleteReason === "max_output_tokens"
          ? "max_tokens"
          : "end_turn";

    yield {
      type: "message_complete",
      response: { stopReason, text, toolCalls, usage },
    };
  }

  /** GET /models（与 Chat Completions 同一目录端点）；过滤 Shutdown */
  async listModels(): Promise<string[]> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) throw await toOpenAIProviderError(res, "OpenAI Responses API");
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

  /** OpenAI 无公开计数端点：按 chars/3 估算（与 core 压缩阈值估算同款） */
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

/** 归一化消息 → Responses input 项；function_call/function_call_output 是一等项 */
export function toResponsesInput(messages: Message[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: [{ type: "input_text", text: m.content }] });
    } else if (m.role === "assistant") {
      if (m.text) {
        out.push({
          role: "assistant",
          content: [{ type: "output_text", text: m.text }],
        });
      }
      for (const tc of m.toolCalls) {
        out.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.input ?? {}),
        });
      }
    } else {
      for (const r of m.results) {
        // function_call_output 只支持文本；图像结果显式告知而非静默丢弃
        const note = r.images?.length
          ? `${r.content}\n[注意: ${r.images.length} 张图片结果在当前协议下无法返回]`
          : r.content;
        out.push({
          type: "function_call_output",
          call_id: r.callId,
          output: r.isError ? `工具调用失败：${note}` : note,
        });
      }
    }
  }
  return out;
}

function toResponsesTools(tools: ToolDef[]): Array<Record<string, unknown>> {
  // Responses 的 function 工具是扁平结构（name/parameters 不嵌套在 function 下）
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
}
