import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "./agent-session";
import { ToolRegistry, sourceOf } from "../tools/registry";
import { readTool } from "../tools/builtin/read";
import { writeTool } from "../tools/builtin/write";
import { todoWriteTool } from "../tools/builtin/todo";
import { PermissionEngine } from "../permission/engine";
import { FakeProvider, toolUseTurn, endTurn } from "../testing/fake-provider";
import { RecordingHost, makeSession } from "../testing/fixtures";
import { ProviderError } from "../errors";
import { buildSystemPrompt, defaultPromptSections } from "../prompt/sections";

async function makeSessionDeps() {
  const dir = await mkdtemp(join(tmpdir(), "wcode-loop-"));
  const host = new RecordingHost();
  const registry = new ToolRegistry();
  await registry.registerSource(
    sourceOf("builtin", [readTool, writeTool, todoWriteTool]),
  );
  const cleanup = () => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  return { dir, host, registry, cleanup };
}

describe("AgentSession 最小循环 e2e", () => {
  it("读文件→回答：完整消息流与事件", async () => {
    const t = await makeSessionDeps();
    try {
      const target = join(t.dir, "note.txt");
      await writeFile(target, "wcode marker 42", "utf8");

      const provider = new FakeProvider([
        { response: toolUseTurn([{ id: "t1", name: "read", input: { file_path: target } }]) },
        { response: endTurn("文件内容是 wcode marker 42") },
      ]);
      const session = new AgentSession({
        provider,
        registry: t.registry,
        host: t.host,
        engine: new PermissionEngine(),
        system: buildSystemPrompt(defaultPromptSections, { cwd: t.dir, platform: process.platform }),
        cwd: t.dir,
        retryDelaysMs: [1],
      });
      const result = await session.run("note.txt 里写了什么？");
      expect(result.status).toBe("end_turn");
      expect(result.reply).toContain("marker 42");

      // 消息序列：user → assistant(tool_use) → tool_result → assistant(最终)
      const m = session.state.messages;
      expect(m).toHaveLength(4);
      expect(m[0]?.role).toBe("user");
      expect(m[1]?.role).toBe("assistant");
      expect(m[2]?.role).toBe("tool_result");
      const results = m[2]?.role === "tool_result" ? m[2].results : [];
      expect(results[0]?.content).toContain("wcode marker 42");

      // 事件序列含 turn_start / text_delta / tool_end / usage / done
      expect(t.host.eventsOfType("turn_start")).toHaveLength(2);
      expect(t.host.eventsOfType("tool_end")).toHaveLength(1);
      expect(t.host.eventsOfType("usage").length).toBeGreaterThanOrEqual(1);
      expect(t.host.events.some((e) => e.type === "done" && e.reason === "end_turn")).toBe(true);

      // 工具定义已传给 provider（含 read）
      const tools = provider.requests[0]?.tools ?? [];
      expect(tools.map((d) => d.name)).toContain("read");
      // system prompt 已传
      expect(provider.requests[0]?.system).toContain("wcode");
    } finally {
      await t.cleanup();
    }
  });

  it("可重试 ProviderError 自动退避重试", async () => {
    const t = await makeSessionDeps();
    try {
      const provider = new FakeProvider([
        { error: new ProviderError("429 too many requests", { retryable: true }) },
        { response: endTurn("recovered") },
      ]);
      const session = new AgentSession({
        provider,
        registry: t.registry,
        host: t.host,
        engine: new PermissionEngine(),
        system: "sys",
        cwd: t.dir,
        retryDelaysMs: [1],
      });
      const result = await session.run("hi");
      expect(result.status).toBe("end_turn");
      expect(result.reply).toBe("recovered");
      const errors = t.host.eventsOfType("error");
      expect(errors.some((e) => e.message.includes("重试"))).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  it("不可重试 ProviderError 直接向上抛", async () => {
    const t = await makeSessionDeps();
    try {
      const provider = new FakeProvider([
        { error: new ProviderError("401 bad key", { retryable: false }) },
      ]);
      const session = new AgentSession({
        provider,
        registry: t.registry,
        host: t.host,
        engine: new PermissionEngine(),
        system: "sys",
        cwd: t.dir,
        retryDelaysMs: [1],
      });
      await expect(session.run("hi")).rejects.toThrow("401");
    } finally {
      await t.cleanup();
    }
  });

  it("达到最大轮数护栏", async () => {
    const t = await makeSessionDeps();
    try {
      const forever = toolUseTurn([{ id: "t", name: "read", input: { file_path: "x" } }]);
      const provider = new FakeProvider(
        Array.from({ length: 10 }, () => ({ response: forever })),
      );
      const session = new AgentSession({
        provider,
        registry: t.registry,
        host: t.host,
        engine: new PermissionEngine(),
        system: "sys",
        cwd: t.dir,
        maxTurns: 3,
        retryDelaysMs: [1],
      });
      const result = await session.run("loop");
      expect(result.status).toBe("max_turns");
    } finally {
      await t.cleanup();
    }
  });

  it("abort 中断挂起的模型流", async () => {
    const t = await makeSessionDeps();
    try {
      const provider = new FakeProvider([{ hang: true }]);
      const session = new AgentSession({
        provider,
        registry: t.registry,
        host: t.host,
        engine: new PermissionEngine(),
        system: "sys",
        cwd: t.dir,
        retryDelaysMs: [1],
      });
      const runPromise = session.run("hi");
      setTimeout(() => session.abort(), 20);
      const result = await runPromise;
      expect(result.status).toBe("aborted");
      expect(t.host.events.some((e) => e.type === "done" && e.reason === "aborted")).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  it("写操作经权限询问（allowAlways 记入会话）", async () => {
    const t = await makeSessionDeps();
    try {
      const target = join(t.dir, "out.txt");
      t.host.permissionResponses.push("allowAlways");
      const provider = new FakeProvider([
        { response: toolUseTurn([{ id: "t1", name: "write", input: { file_path: target, content: "data" } }]) },
        { response: endTurn("written") },
      ]);
      const engine = new PermissionEngine();
      const session = new AgentSession({
        provider,
        registry: t.registry,
        host: t.host,
        engine,
        system: "sys",
        cwd: t.dir,
        retryDelaysMs: [1],
      });
      const result = await session.run("写文件");
      expect(result.status).toBe("end_turn");
      // 第二次同类写不再询问（权限被会话学习）
      expect(engine.evaluate({ toolName: "write", isReadOnly: false, patterns: [`write(${target})`] }).decision).toBe("allow");
    } finally {
      await t.cleanup();
    }
  });
});

describe("AgentSession W2：上下文管理与 todo", () => {
  it("超过阈值触发压缩：摘要注入、compacted 事件、后续请求带摘要", async () => {
    const t = await makeSessionDeps();
    try {
      const big = join(t.dir, "big.txt");
      await writeFile(big, "K".repeat(2000), "utf8"); // ~667 tokens 的工具结果

      const provider = new FakeProvider([
        { response: toolUseTurn([{ id: "t1", name: "read", input: { file_path: big } }]) },
        { response: endTurn("## 任务目标\n摘要标记XYZ") }, // 被当作摘要消费
        { response: endTurn("final") },
      ]);
      const session = new AgentSession({
        provider,
        registry: t.registry,
        host: t.host,
        engine: new PermissionEngine(),
        system: "sys",
        cwd: t.dir,
        retryDelaysMs: [1],
        maxContextTokens: 500, // 阈值 400 < ~680，第二轮前触发
        compactThreshold: 0.8,
      });
      const result = await session.run("读取 big.txt");
      expect(result.status).toBe("end_turn");
      expect(result.reply).toBe("final");

      // 摘要请求走的是 provider 第二轮
      const summaryReq = provider.requests[1]!;
      expect(summaryReq.system).toContain("摘要");
      // 压缩后的正式请求：消息历史被替换为 摘要注入 + 最近 2 条
      const turn2Req = provider.requests[2]!;
      const first = turn2Req.messages[0]!;
      expect(first.role).toBe("user");
      expect((first as { content: string }).content).toContain("上下文已压缩");
      expect((first as { content: string }).content).toContain("摘要标记XYZ");
      expect(turn2Req.messages.length).toBeLessThanOrEqual(3);

      expect(t.host.events.some((e) => e.type === "compacted")).toBe(true);
      expect(session.state.messages[0]!.role).toBe("user");
    } finally {
      await t.cleanup();
    }
  });

  it("微清理进入请求：较老的大工具结果变为占位符", async () => {
    const t = await makeSessionDeps();
    try {
      const big = join(t.dir, "big.txt");
      await writeFile(big, "K".repeat(1000), "utf8");
      const small = join(t.dir, "small.txt");
      await writeFile(small, "tiny\n", "utf8");

      const provider = new FakeProvider([
        { response: toolUseTurn([{ id: "t1", name: "read", input: { file_path: big } }]) },
        { response: toolUseTurn([{ id: "t2", name: "read", input: { file_path: small } }]) },
        { response: toolUseTurn([{ id: "t3", name: "read", input: { file_path: small } }]) },
        { response: endTurn("done") },
      ]);
      const session = new AgentSession({
        provider,
        registry: t.registry,
        host: t.host,
        engine: new PermissionEngine(),
        system: "sys",
        cwd: t.dir,
        retryDelaysMs: [1],
      });
      const result = await session.run("连续读文件");
      expect(result.reply).toBe("done");

      // 第 4 轮请求中：最早的大 tool_result 已被清理，最近两条保留
      const lastReq = provider.requests[3]!;
      const toolResults = lastReq.messages.filter((m) => m.role === "tool_result");
      const first = (toolResults[0] as { results: Array<{ content: string }> }).results[0]!.content;
      expect(first).toContain("已清理");
      expect(toolResults.length).toBe(3);
    } finally {
      await t.cleanup();
    }
  });

  it("todo_write 更新会话清单并发出 todos_changed", async () => {
    const t = await makeSessionDeps();
    try {
      const provider = new FakeProvider([
        {
          response: toolUseTurn([
            {
              id: "t1",
              name: "todo_write",
              input: {
                items: [
                  { content: "步骤一", status: "completed" },
                  { content: "步骤二", status: "in_progress", priority: "high" },
                ],
              },
            },
          ]),
        },
        { response: endTurn("planned") },
      ]);
      const session = new AgentSession({
        provider,
        registry: t.registry,
        host: t.host,
        engine: new PermissionEngine(),
        system: "sys",
        cwd: t.dir,
        retryDelaysMs: [1],
      });
      await session.run("列个计划");
      expect(session.state.todos).toHaveLength(2);
      expect(session.state.todos[1]?.content).toBe("步骤二");
      const todoEvents = t.host.eventsOfType("todos_changed");
      expect(todoEvents).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });
});
