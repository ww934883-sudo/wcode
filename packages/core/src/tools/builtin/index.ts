import { bashTool } from "./bash";
import { editTool } from "./edit";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { readTool } from "./read";
import { taskOutputTool, taskStopTool } from "./tasks";
import { taskTool } from "./task";
import { todoReadTool, todoWriteTool } from "./todo";
import { writeTool } from "./write";
import { sourceOf, type ToolSource } from "../registry";
import type { Tool } from "../tool";

/** 内置工具全集（单一注册入口，evals / cli / 测试共用） */
export const builtinTools: Tool[] = [
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
  taskTool,
];

export const builtinToolSource: ToolSource = {
  id: "builtin",
  listTools: () => builtinTools,
};

export { sourceOf };
