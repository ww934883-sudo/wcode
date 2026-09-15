import { z } from "zod";
import { defineTool } from "../tool";
import type { TodoItem } from "../../session/state";

const TodoItemSchema = z.object({
  content: z.string().min(1).describe("任务内容"),
  status: z.enum(["pending", "in_progress", "completed"]).describe("状态"),
  priority: z.enum(["high", "medium", "low"]).optional().describe("优先级"),
});

const TodoWriteSchema = z.object({
  items: z.array(TodoItemSchema).describe("完整任务清单（整表替换，多步任务先列清单再逐步更新）"),
});

const TodoReadSchema = z.object({});

export function renderChecklist(items: TodoItem[]): string {
  if (items.length === 0) return "(任务清单为空)";
  const icon: Record<string, string> = {
    completed: "[x]",
    in_progress: "[~]",
    pending: "[ ]",
  };
  return items
    .map((t) => {
      const prio = t.priority ? `（${t.priority}）` : "";
      return `${icon[t.status] ?? "[ ]"} ${t.content}${prio}`;
    })
    .join("\n");
}

export const todoWriteTool = defineTool({
  name: "todo_write",
  description:
    "写入/更新任务清单（整表替换）。多步任务开始前列清单，每完成一步更新状态；" +
    "同一时刻保持恰好一个 in_progress。",
  schema: TodoWriteSchema,
  // 不产生会话外副作用：权限按只读处理，批内可并行
  isReadOnly: true,
  execute: async (input, ctx) => {
    ctx.session.todos = input.items;
    ctx.emitEvent?.({ type: "todos_changed", todos: input.items });
    return { content: renderChecklist(input.items) };
  },
});

export const todoReadTool = defineTool({
  name: "todo_read",
  description: "读取当前任务清单。",
  schema: TodoReadSchema,
  isReadOnly: true,
  execute: async (_input, ctx) => ({ content: renderChecklist(ctx.session.todos) }),
});
