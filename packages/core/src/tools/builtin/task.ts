import { z } from "zod";
import { defineTool, type Tool } from "../tool";
import type { CustomAgentDef } from "../../agents/defs";

export interface SubAgentTask {
  /** 任务描述，必须自包含（目标、背景、期望产出）——子 Agent 看不到主对话 */
  prompt: string;
  /** 子 Agent 可用工具集：readonly（默认，探索/搜索）或 all（除 task 外） */
  tools?: "all" | "readonly";
  /** 自定义子 Agent 名（来自 agents 定义目录）；缺省用默认子 Agent */
  subagent?: string;
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
  subagent: z
    .string()
    .optional()
    .describe("要使用的自定义子 Agent 名（见工具描述中的可用列表）；缺省用默认子 Agent"),
});

function agentCatalog(agents: CustomAgentDef[]): string {
  return agents
    .map((a) => {
      const tools =
        a.tools === "all" ? "全部工具" : a.tools === "readonly" ? "只读工具" : a.tools.join("/");
      return `- ${a.name}：${a.description || "（无描述）"}（工具: ${tools}）`;
    })
    .join("\n");
}

/**
 * task 工具工厂。传入自定义子 Agent 定义时：
 *   - schema 增加 subagent 参数说明
 *   - 工具描述动态列出可用子 Agent（名字 + 描述 + 工具集），模型据此选择
 */
export function createTaskTool(agents: CustomAgentDef[] = []): Tool {
  const catalog = agents.length > 0 ? `\n可用子 Agent:\n${agentCatalog(agents)}` : "";
  return defineTool({
    name: "task",
    description:
      "派生一个子 Agent 执行独立任务（如大范围代码搜索、多文件调研），" +
      "只把最终结论返回主对话，过程不污染上下文。任务描述必须自包含。" +
      "子 Agent 继承权限规则；write 类操作仍会向用户请求确认。" +
      catalog,
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
        subagent: input.subagent,
      });
      return { content: reply };
    },
  });
}

/** 默认 task 工具（无自定义子 Agent），兼容既有引用 */
export const taskTool: Tool = createTaskTool();
