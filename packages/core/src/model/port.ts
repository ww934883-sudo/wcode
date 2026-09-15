import type { Message, StopReason, ToolCall, ToolDef, Usage } from "../types";

export interface ModelRequest {
  /** 已组装好的 system prompt */
  system: string;
  messages: Message[];
  tools: ToolDef[];
  maxTokens: number;
  /** 中断贯穿：session 的 AbortController signal */
  signal: AbortSignal;
}

export interface ModelResponse {
  stopReason: StopReason;
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "message_complete"; response: ModelResponse };

/**
 * 模型接入端口（接缝一）。provider-* 实现本接口，
 * core 不感知任何具体协议。思维链内容必须在 provider 层丢弃，
 * 429/5xx 的重试由 core 的 loop 层负责，provider 只翻译错误分类。
 */
export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  stream(req: ModelRequest): AsyncIterable<StreamEvent>;
  countTokens(messages: Message[]): Promise<number>;
  /**
   * 可选能力：列出该 provider 端点可用的模型 id（/model 选择列表）。
   * 网关不支持或请求失败时由调用方降级为手输模型名。
   */
  listModels?(): Promise<string[]>;
}
