import { z } from "zod";
import { defineTool } from "../tool";

export interface SubAgentTask {
  /** 任务描述，必须自包含（目标、背景、期望产出）——子 Agent 看不到主对话 */
  prompt: string;
  /** 子 Agent 可用工具集：readonly（默认，探索/搜索）或 all（除 task 外） */
  tools?: "all" | "readonly";
}

const TaskSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe("子 Agent 的任务描述（必须自包含：子 Agent 看不到主对话历史）"),
  tools: z
    .enum(["readonly", "all"])
    .optional()
    .describe("子 Agent 可用工具集，默认 readonly（只读探索，适合搜索/调研）"),
});

export const taskTool = defineTool({
  name: "task",
  description:
    "派生一个子 Agent 执行独立任务（如大范围代码搜索、多文件调研），" +
    "只把最终结论返回主对话，过程不污染上下文。任务描述必须自包含。" +
    "子 Agent 继承权限规则；write 类操作仍会向用户请求确认。",
  schema: TaskSchema,
  // 编排工具本身无副作用（子操作的权限由子 Agent 单独判定），
  // 标记只读使其可在批内并行执行
  isReadOnly: true,
  execute: async (input, ctx) => {
    if (!ctx.spawn) {
      return { content: "子 Agent 能力未启用（当前环境不支持 spawn）。" };
    }
    const reply = await ctx.spawn({
      prompt: input.prompt,
      tools: input.tools ?? "readonly",
    });
    return { content: reply };
  },
});
