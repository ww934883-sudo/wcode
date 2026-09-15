import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDef } from "../types";
import type { Logger } from "../logging/port";
import type { SessionState } from "../session/state";

export interface ToolOutput {
  content: string;
  isTruncated?: boolean;
}

export interface ToolContext {
  session: SessionState;
  signal: AbortSignal;
  log: Logger;
}

/**
 * 工具接口（接缝二）。execute 不允许向 loop 抛出业务错误——
 * 普通错误由执行管道捕获转为结果；只有 AbortedError 允许穿透。
 */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodTypeAny;
  readonly isReadOnly: boolean;
  /** 供权限规则匹配的模式串，如 ["Edit(src/app.ts)"] */
  rulePatterns(input: unknown): string[];
  execute(input: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

export interface ToolDefinition<T> {
  name: string;
  description: string;
  schema: z.ZodType<T>;
  isReadOnly: boolean;
  rulePatterns?: (input: T) => string[];
  execute: (input: T, ctx: ToolContext) => Promise<ToolOutput>;
}

/** defineTool 提供类型收窄：业务代码拿到的 input 已经 schema 解析 */
export function defineTool<T>(def: ToolDefinition<T>): Tool {
  return {
    name: def.name,
    description: def.description,
    schema: def.schema,
    isReadOnly: def.isReadOnly,
    rulePatterns: (input: unknown) => {
      const parsed = def.schema.safeParse(input);
      if (def.rulePatterns && parsed.success) {
        return def.rulePatterns(parsed.data);
      }
      // 参数非法时退化为工具名级别匹配，权限判定不因坏参数而失真
      return [def.name];
    },
    execute: (input: unknown, ctx) => def.execute(def.schema.parse(input), ctx),
  };
}

export function toToolDef(tool: Tool): ToolDef {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.schema, { $refStrategy: "none" }),
  };
}
