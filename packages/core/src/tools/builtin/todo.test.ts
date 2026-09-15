import { describe, expect, it } from "vitest";
import { todoReadTool, todoWriteTool, renderChecklist } from "./todo";
import { makeToolContext, makeSession } from "../../testing/fixtures";
import type { AgentEvent } from "../../host/port";

describe("todo 工具", () => {
  it("todo_write 写入会话状态并发出 todos_changed 事件", async () => {
    const session = makeSession("/tmp");
    const events: AgentEvent[] = [];
    const ctx = makeToolContext(session);
    ctx.emitEvent = (e) => events.push(e);

    const out = await todoWriteTool.execute(
      {
        items: [
          { content: "实现编辑器", status: "completed" },
          { content: "写测试", status: "in_progress", priority: "high" },
          { content: "发布", status: "pending" },
        ],
      },
      ctx,
    );
    expect(session.todos).toHaveLength(3);
    expect(events.some((e) => e.type === "todos_changed")).toBe(true);
    expect(out.content).toContain("[x] 实现编辑器");
    expect(out.content).toContain("[~] 写测试（high）");
    expect(out.content).toContain("[ ] 发布");
  });

  it("todo_read 读取当前清单", async () => {
    const session = makeSession("/tmp");
    session.todos = [{ content: "唯一的任务", status: "pending" }];
    const out = await todoReadTool.execute({}, makeToolContext(session));
    expect(out.content).toContain("[ ] 唯一的任务");
  });

  it("空清单渲染", () => {
    expect(renderChecklist([])).toBe("(任务清单为空)");
  });
});
