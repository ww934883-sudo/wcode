import { bashTool } from "./bash";
import { editTool } from "./edit";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { readTool } from "./read";
import { taskOutputTool, taskStopTool } from "./tasks";
import { createTaskTool } from "./task";
import { todoReadTool, todoWriteTool } from "./todo";
import { writeTool } from "./write";
import { sourceOf, type ToolSource } from "../registry";
import type { Tool } from "../tool";
import type { SkillDefinition } from "../../skills/skills";
import { createSkillTool } from "../../skills/skills";
import type { CustomAgentDef } from "../../agents/defs";

function buildBuiltinTools(opts?: {
  skills?: SkillDefinition[];
  agents?: CustomAgentDef[];
}): Tool[] {
  const tools: Tool[] = [
    readTool,
    writeTool,
    editTool,
    globTool,
    grepTool,
    bashTool,
    todoWriteTool,
    todoReadTool,
    taskOutputTool,
    taskStopTool,
    createTaskTool(opts?.agents ?? []),
  ];
  // 有可用技能才注册 skill 工具（避免空目录列表迷惑模型）
  if (opts?.skills && opts.skills.length > 0) {
    tools.push(createSkillTool(opts.skills));
  }
  return tools;
}

/** 内置工具源工厂：evals / cli / 测试共用；skills/agents 注入后扩展开关按需生效 */
export function createBuiltinToolSource(opts?: {
  skills?: SkillDefinition[];
  agents?: CustomAgentDef[];
}): ToolSource {
  const tools = buildBuiltinTools(opts);
  return {
    id: "builtin",
    listTools: () => tools,
  };
}

/** 无 skills/agents 的默认源（兼容既有引用） */
export const builtinToolSource: ToolSource = createBuiltinToolSource();

export { sourceOf };
