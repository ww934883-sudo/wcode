import type {
  Message,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StreamEvent,
  ToolCall,
  ToolDef,
} from "@wcode/core";
import { AbortedError, isAbortedError, ProviderError } from "@wcode/core";

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  apiVersion?: string;
  /** 测试注入 mock fetch */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_API_VERSION = "2023-06-01";

/**
 * Anthropic Messages 协议适配（架构文档 §2.2 / §14）：
 * 归一化类型 ↔ 线格式翻译 + SSE 流解析。思维链字段不回传；
 * 错误只翻译成 ProviderError{retryable}，重试节奏由 core 决定。
 */
export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AnthropicProviderOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.maxTokens = opts.maxTokens ?? 8192;
    this.apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    const body = {
      model: this.model,
      max_tokens: Math.min(req.maxTokens, this.maxTokens),
      system: req.system,
      messages: toAnthropicMessages(req.messages),
      ...(req.tools.length > 0 ? { tools: toAnthropicTools(req.tools) } : {}),
      stream: true,
    };

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": this.apiVersion,
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      if (isAbortedError(err) || req.signal.aborted) throw new AbortedError();
      throw new ProviderError(`网络错误: ${describe(err)}`, { retryable: true });
    }

    if (!res.ok) throw await toProviderError(res);

    // SSE 解析：按行缓冲，只处理 data: 行
    const reader = res.body?.getReader();
    if (!reader) {
      throw new ProviderError("响应无内容流", { retryable: false });
    }
    const decoder = new TextDecoder();
    let buffer = "";

    let text = "";
    let stopReason: ModelResponse["stopReason"] = "end_turn";
    let usage = { inputTokens: 0, outputTokens: 0 };
    // index → 进行中的 tool_use 块
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

    const handlePayload = (payloadStr: string): StreamEvent | null => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(payloadStr) as Record<string, unknown>;
      } catch {
        return null; // 忽略不可解析的行
      }
      const type = payload.type as string;
      if (type === "message_start") {
        const msg = payload.message as { usage?: { input_tokens?: number } } | undefined;
        usage.inputTokens = msg?.usage?.input_tokens ?? usage.inputTokens;
      } else if (type === "content_block_start") {
        const index = payload.index as number;
        const block = payload.content_block as { type: string; id?: string; name?: string };
        if (block.type === "tool_use") {
          toolBlocks.set(index, { id: block.id ?? "", name: block.name ?? "", json: "" });
        }
      } else if (type === "content_block_delta") {
        const index = payload.index as number;
        const delta = payload.delta as { type: string; text?: string; partial_json?: string };
        if (delta.type === "text_delta" && delta.text) {
          text += delta.text;
          return { type: "text_delta", text: delta.text };
        }
        if (delta.type === "input_json_delta" && delta.partial_json) {
          const block = toolBlocks.get(index);
          if (block) block.json += delta.partial_json;
        }
      } else if (type === "message_delta") {
        const delta = payload.delta as { stop_reason?: string };
        const outUsage = payload.usage as
          | { output_tokens?: number; input_tokens?: number }
          | undefined;
        usage.outputTokens = outUsage?.output_tokens ?? usage.outputTokens;
        // 部分兼容网关（如火山）仅在 message_delta 携带完整 usage
        usage.inputTokens = outUsage?.input_tokens ?? usage.inputTokens;
        if (delta.stop_reason === "tool_use") stopReason = "tool_use";
        else if (delta.stop_reason === "max_tokens") stopReason = "max_tokens";
        else stopReason = "end_turn";
      } else if (type === "error") {
        const apiErr = payload.error as { message?: string } | undefined;
        throw new ProviderError(`流中错误: ${apiErr?.message ?? "unknown"}`, {
          retryable: false,
        });
      }
      return null;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineAt: number;
        while ((newlineAt = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineAt).trim();
          buffer = buffer.slice(newlineAt + 1);
          if (!line.startsWith("data:")) continue;
          const ev = handlePayload(line.slice(5).trim());
          if (ev) yield ev;
        }
      }
    } catch (err) {
      if (isAbortedError(err) || req.signal.aborted) throw new AbortedError();
      // 流中途断开：无副作用，可重试
      throw new ProviderError(`流中断: ${describe(err)}`, { retryable: true });
    }

    const toolCalls: ToolCall[] = [...toolBlocks.values()].map((b) => {
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

  async countTokens(messages: Message[]): Promise<number> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/messages/count_tokens`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": this.apiVersion,
        },
        body: JSON.stringify({ model: this.model, messages: toAnthropicMessages(messages) }),
      });
      if (!res.ok) throw await toProviderError(res);
      const data = (await res.json()) as { input_tokens?: number };
      return data.input_tokens ?? 0;
    } catch (err) {
      if (isAbortedError(err)) throw new AbortedError();
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(`countTokens 失败: ${describe(err)}`, { retryable: true });
    }
  }
}

/** 归一化消息 → Anthropic 线格式；连续 tool_result 合并进同一条 user 消息 */
export function toAnthropicMessages(messages: Message[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let pendingToolResults: Array<Record<string, unknown>> = [];

  const flushToolResults = (): void => {
    if (pendingToolResults.length > 0) {
      out.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const m of messages) {
    if (m.role === "tool_result") {
      for (const r of m.results) {
        pendingToolResults.push({
          type: "tool_result",
          tool_use_id: r.callId,
          content: [
            { type: "text", text: r.content },
            ...(r.images ?? []).map((im) => ({
              type: "image",
              source: { type: "base64", media_type: im.mediaType, data: im.data },
            })),
          ],
          ...(r.isError ? { is_error: true } : {}),
        });
      }
      continue;
    }
    flushToolResults();
    if (m.role === "user") {
      out.push({ role: "user", content: [{ type: "text", text: m.content }] });
    } else {
      const content: Array<Record<string, unknown>> = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const tc of m.toolCalls) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      }
      out.push({ role: "assistant", content });
    }
  }
  flushToolResults();
  return out;
}

function toAnthropicTools(tools: ToolDef[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

async function toProviderError(res: Response): Promise<ProviderError> {
  let apiMessage = "";
  try {
    const data = (await res.json()) as { error?: { message?: string } };
    apiMessage = data.error?.message ?? "";
  } catch {
    apiMessage = await res.text().catch(() => "");
  }
  const status = res.status;
  const retryable = status === 408 || status === 429 || status >= 500;
  const hint =
    status === 401 || status === 403
      ? "（请检查 API key 与权限）"
      : status === 429
        ? "（限流，将自动重试）"
        : "";
  return new ProviderError(`Anthropic API ${status}: ${apiMessage || res.statusText}${hint}`, {
    retryable,
    status,
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
