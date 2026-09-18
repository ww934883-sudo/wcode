import type { Message, StopReason, ToolCall, ToolDef, Usage } from "../types";

/**
 * 思考级别（推理力度）。缺省/undefined = 不向 provider 传任何思考参数，
 * 行为与未接线前完全一致（向后兼容）。具体预算/参数由各 provider 自行映射。
 */
export type ThinkingLevel = "off" | "low" | "medium" | "high";

/** 全部档位；provider 未声明 thinkingLevels 能力时的缺省假设 */
export const ALL_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high"];

export interface ModelRequest {
  /** 已组装好的 system prompt */
  system: string;
  messages: Message[];
  tools: ToolDef[];
  maxTokens: number;
  /** 思考级别；off 或 undefined 都不传思考参数 */
  thinking?: ThinkingLevel;
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
  /**
   * 可选能力：当前绑定模型支持的思考档位（与 listModels 同为先例式可选方法）。
   * 三态语义：方法缺省 = 未知（调用方按全档处理，与未接线前一致）；
   * 返回空数组 = 明确不支持思考参数，调用方不得发送；返回子集 = 只可选用列出的档位。
   * 厂商没有能力元数据端点可查，家族判断由各 provider 静态维护。
   */
  thinkingLevels?(): ThinkingLevel[];
}
