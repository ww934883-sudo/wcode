/**
 * 全项目唯一的消息 / 工具类型定义处（M1-生产级架构设计 §2.2）。
 * provider-* 只做「归一化类型 ↔ 各家协议」的翻译，核心层只见这里的类型。
 */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  mediaType: string;
  /** base64 编码，M3 多模态启用 */
  data: string;
}

export type ContentBlock = TextBlock | ImageBlock;

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * M1 工具输出以文本为主；images 携带多模态结果（如 read 读图）。
 * provider 适配器负责把 images 映射为各家协议的图像块。
 */
export interface ToolResultBlock {
  callId: string;
  content: string;
  isError: boolean;
  images?: ImageBlock[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens";

export type JSONSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

/**
 * 归一化消息历史。tool_result 独立成角色，由 provider 适配器负责映射到
 * 各家协议的线格式（如 Anthropic 需并入下一条 user 消息）。
 */
export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; usage?: Usage }
  | { role: "tool_result"; results: ToolResultBlock[] };
