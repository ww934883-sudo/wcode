import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "./agent-session";
import { ToolRegistry, sourceOf } from "../tools/registry";
import { readTool } from "../tools/builtin/read";
import { writeTool } from "../tools/builtin/write";
import { bashTool } from "../tools/builtin/bash";
import { createTaskTool } from "../tools/builtin/task";
import { PermissionEngine } from "../permission/engine";
import { FakeProvider, toolUseTurn, endTurn } from "../testing/fake-provider";
import { RecordingHost } from "../testing/fixtures";
import { configSchema, type HooksConfig } from "../config/schema";
import type { CustomAgentDef } from "../agents/defs";

async function makeSessionDeps() {
  const dir = await mkdtemp(join(tmpdir(), "wcode-m2-"));
  const host = new RecordingHost();
  const cleanup = () =>
    rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  return { dir, host, cleanup };
}

function hooksOf(partial: Record<string, unknown>): HooksConfig {
  return configSchema.parse({ hooks: partial }).hooks;
}

const explorerDef: CustomAgentDef = {
  name: "explorer",
  description: "只读探索",
  tools: "readonly",
  body: "你只负责找文件，不要修改任何东西。",
  source: "user",
  path: "/fake/explorer.md",
};

describe("AgentSession M2：Hooks", () => {
  it("pre-hook 退出码 2 阻断工具调用，原因进入 isError 结果", async () => {
    const t = await makeSessionDeps();
    try {
      const provider = new FakeProvider([
        { response: toolUseTurn([{ id: "t1", name: "read", input: { file_path: "a.ts" } }]) },
        { response: endTurn("收到阻断，停止操作") },
      ]);
      const registry = new ToolRegistry();
      await registry.registerSource(sourceOf("builtin", [readTool, writeTool]));
      const session = new AgentSession({
        provider,
        registry,
        host: t.host,
        engine: new PermissionEngine(),
        system: "sys",
        cwd: t.dir,
        retryDelaysMs: [1],
        hooks: hooksOf({
          preToolUse: [
            { matcher: "read", command: 'node -e "console.error(\'禁区\');process.exit(2)"' },
          ],
        }),
      });
      const result = await session.run("读一下 a.ts");
      expect(result.status).toBe("end_turn");
      // 阻断结果作为 isError 工具结果进入对话
      const toolResult = session.state.messages.find((m) => m.role === "tool_result");
      expect(toolResult && toolResult.role === "tool_result").toBe(true);
      const blocked = toolResult?.role === "tool_result" ? toolResult.results[0] : undefined;
      expect(blocked?.isError).toBe(true);
      expect(blocked?.content).toContain("阻断");
      expect(blocked?.content).toContain("禁区");
    } finally {
      await t.cleanup();
    }
  });

  it("未配置 hook 事件时管道零开销（不触发任何 hook 进程）", async () => {
    const t = await makeSessionDeps();
    try {
      const provider = new FakeProvider([{ response: endTurn("无工具轮") }]);
      const registry = new ToolRegistry();
      await registry.registerSource(sourceOf("builtin", [readTool]));
      const session = new AgentSession({
        provider,
        registry,
        host: t.host,
        engine: new PermissionEngine(),
        system: "sys",
        cwd: t.dir,
        retryDelaysMs: [1],
        hooks: hooksOf({}), // hooks 存在但三个事件都为空
      });
      const result = await session.run("你好");
      expect(result.status).toBe("end_turn");
      expect(provider.requests).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });
});

describe("AgentSession M2：自定义子 Agent", () => {
  it("subagent 命中定义：正文作 system prompt，工具集收敛为 readonly", async () => {
    const t = await makeSessionDeps();
    try {
      const provider = new FakeProvider([
        { response: toolUseTurn([{ id: "t1", name: "task", input: { prompt: "找 marker 文件", subagent: "explorer" } }]) },
        { response: endTurn("子 Agent 汇报：找到了") },
        { response: endTurn("主对话收尾") },
      ]);
      const registry = new ToolRegistry();
      await registry.registerSource(
        sourceOf("builtin", [readTool, writeTool, createTaskTool([explorerDef])]),
      );
      const session = new AgentSession({
        provider,
        registry,
        host: t.host,
        engine: new PermissionEngine(),
        system: "sys",
        cwd: t.dir,
        retryDelaysMs: [1],
        customAgents: [explorerDef],
      });
      const result = await session.run("派 explorer 找文件");
      expect(result.reply).toBe("主对话收尾");

      // 子 Agent 的请求：system 来自定义正文，工具只有只读集
      expect(provider.requests.length).toBe(3);
      const childReq = provider.requests[1];
      expect(childReq?.system).toContain("你只负责找文件，不要修改任何东西。");
      expect(childReq?.system).toContain("找 marker 文件");
      expect(childReq?.tools.map((d) => d.name)).toEqual(["read"]);
    } finally {
      await t.cleanup();
    }
  });

  it("tools 为名字列表时按列表收敛（bash 显式授权）", async () => {
    const t = await makeSessionDeps();
    try {
      const def: CustomAgentDef = {
        ...explorerDef,
        name: "tester",
        tools: ["read", "bash"],
        body: "跑测试专用",
      };
      const provider = new FakeProvider([
        { response: toolUseTurn([{ id: "t1", name: "task", input: { prompt: "跑测试", subagent: "tester" } }]) },
        { response: endTurn("测试通过") },
        { response: endTurn("done") },
      ]);
      const registry = new ToolRegistry();
      await registry.registerSource(
        sourceOf("builtin", [readTool, writeTool, bashTool, createTaskTool([def])]),
      );
      const session = new AgentSession({
        provider,
        registry,
        host: t.host,
        engine: new PermissionEngine(),
        system: "sys",
        cwd: t.dir,
        retryDelaysMs: [1],
        customAgents: [def],
      });
      await session.run("派 tester");
      const childReq = provider.requests[1];
      expect(childReq?.tools.map((d) => d.name).sort()).toEqual(["bash", "read"]);
      expect(childReq?.system).toContain("跑测试专用");
    } finally {
      await t.cleanup();
    }
  });

  it("未知 subagent 返回教学式错误且不发起子请求", async () => {
    const t = await makeSessionDeps();
    try {
      const provider = new FakeProvider([
        { response: toolUseTurn([{ id: "t1", name: "task", input: { prompt: "x", subagent: "ghost" } }]) },
        { response: endTurn("明白，改用默认子 Agent") },
      ]);
      const registry = new ToolRegistry();
      await registry.registerSource(sourceOf("builtin", [createTaskTool([explorerDef])]));
      const session = new AgentSession({
        provider,
        registry,
        host: t.host,
        engine: new PermissionEngine(),
        system: "sys",
        cwd: t.dir,
        retryDelaysMs: [1],
        customAgents: [explorerDef],
      });
      await session.run("派 ghost");
      expect(provider.requests).toHaveLength(2); // 没有子 Agent 请求
      const toolResult = session.state.messages.find((m) => m.role === "tool_result");
      const content = toolResult?.role === "tool_result" ? toolResult.results[0]?.content : "";
      expect(content).toContain('未知子 Agent "ghost"');
      expect(content).toContain("explorer（只读探索）");
    } finally {
      await t.cleanup();
    }
  });
});

describe("AgentSession M2：斜杠命令接口（setProvider / goal / compactNow）", () => {
  it("setGoal 并入 system prompt，压缩后依然有效（effectiveSystem）", async () => {
    const t = await makeSessionDeps();
    try {
      const provider = new FakeProvider([{ response: endTurn("收到") }]);
      const registry = new ToolRegistry();
      await registry.registerSource(sourceOf("builtin", [readTool]));
      const session = new AgentSession({
        provider,
        registry,
        host: t.host,
        engine: new PermissionEngine(),
        system: "sys",
        cwd: t.dir,
        retryDelaysMs: [1],
      });
      session.setGoal("完成重构并保持测试全绿");
      await session.run("开始");
      expect(provider.requests[0]?.system).toContain("[当前任务目标");
      expect(provider.requests[0]?.system).toContain("完成重构并保持测试全绿");

      session.setGoal("  ");
      expect(session.getGoal()).toBeUndefined(); // 空白视为清除
    } finally {
      await t.cleanup();
    }
  });

  it("compactNow 跳过阈值直接压缩：摘要注入 + 保留最近消息", async () => {
    const t = await makeSessionDeps();
    try {
      const provider = new FakeProvider([
        { response: endTurn("第一轮") },
        { response: endTurn("第二轮") },
        { response: endTurn("这是结构化摘要") },
      ]);
      const registry = new ToolRegistry();
      await registry.registerSource(sourceOf("builtin", [readTool]));
      const session = new AgentSession({
        provider,
        registry,
        host: t.host,
        engine: new PermissionEngine(),
        system: "sys",
        cwd: t.dir,
        retryDelaysMs: [1],
      });
      await session.run("任务一");
      await session.run("任务二");
      expect(session.state.messages).toHaveLength(4);

      const note = await session.compactNow();
      expect(note).toContain("已压缩上下文");
      expect(session.state.messages).toHaveLength(3); // 注入摘要 + 保留最近 2 条
      const inject = session.state.messages[0];
      expect(inject?.role === "user" && inject.content).toContain("这是结构化摘要");
      expect(t.host.eventsOfType("compacted")).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });

  it("compactNow 空历史提示无需压缩", async () => {
    const t = await makeSessionDeps();
    try {
      const provider = new FakeProvider([]);
      const registry = new ToolRegistry();
      const session = new AgentSession({
        provider,
        registry,
        host: t.host,
        engine: new PermissionEngine(),
        system: "sys",
        cwd: t.dir,
        retryDelaysMs: [1],
      });
      const note = await session.compactNow();
      expect(note).toContain("无需压缩");
      expect(provider.requests).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });

  it("setProvider 运行期切换模型，下一轮立即生效", async () => {
    const t = await makeSessionDeps();
    try {
      const providerA = new FakeProvider([]);
      const providerB = new FakeProvider([{ response: endTurn("来自新模型") }]);
      const registry = new ToolRegistry();
      const session = new AgentSession({
        provider: providerA,
        registry,
        host: t.host,
        engine: new PermissionEngine(),
        system: "sys",
        cwd: t.dir,
        retryDelaysMs: [1],
      });
      session.setProvider(providerB);
      const result = await session.run("你好");
      expect(result.reply).toBe("来自新模型");
      expect(providerA.requests).toHaveLength(0);
      expect(providerB.requests).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });
});

describe("AgentSession M2：applyRuntime（/reload）与 applyResume（/resume）", () => {
  it("applyRuntime 换注册表与系统提示后立即生效", async () => {
    const t = await makeSessionDeps();
    try {
      const provider = new FakeProvider([
        { response: toolUseTurn([{ id: "t1", name: "write", input: { file_path: "a.txt", content: "x" } }]) },
        { response: endTurn("done") },
      ]);
      const registryA = new ToolRegistry();
      await registryA.registerSource(sourceOf("builtin", [readTool]));
      const session = new AgentSession({
        provider,
        registry: registryA,
        host: t.host,
        engine: new PermissionEngine(),
        system: "sys-v1",
        cwd: t.dir,
        retryDelaysMs: [1],
      });

      const registryB = new ToolRegistry();
      await registryB.registerSource(sourceOf("builtin", [writeTool]));
      session.applyRuntime({ registry: registryB, system: "sys-v2" });
      await session.run("写个文件");

      // 新请求只带新注册表的工具，system 已更新
      const req = provider.requests[0];
      expect(req?.system).toBe("sys-v2");
      expect(req?.tools.map((d) => d.name)).toEqual(["write"]);
    } finally {
      await t.cleanup();
    }
  });

  it("applyRuntime 换 hooks 后新注册表生效（阻断规则热更新）", async () => {
    const t = await makeSessionDeps();
    try {
      const provider = new FakeProvider([
        { response: toolUseTurn([{ id: "t1", name: "read", input: { file_path: "a.ts" } }]) },
        { response: endTurn("收到阻断") },
      ]);
      const registry = new ToolRegistry();
      await registry.registerSource(sourceOf("builtin", [readTool]));
      const session = new AgentSession({
        provider,
        registry,
        host: t.host,
        engine: new PermissionEngine(),
        system: "sys",
        cwd: t.dir,
        retryDelaysMs: [1],
        hooks: hooksOf({}), // 初始无 hook
      });
      session.applyRuntime({
        hooks: hooksOf({
          preToolUse: [{ matcher: "read", command: 'node -e "process.exit(2)"' }],
        }),
      });
      await session.run("读文件");
      const toolResult = session.state.messages.find((m) => m.role === "tool_result");
      const blocked = toolResult?.role === "tool_result" ? toolResult.results[0] : undefined;
      expect(blocked?.isError).toBe(true);
      expect(blocked?.content).toContain("阻断");
    } finally {
      await t.cleanup();
    }
  });

  it("applyResume 替换消息历史与 store，作废 todos/filesRead", async () => {
    const t = await makeSessionDeps();
    try {
      const provider = new FakeProvider([{ response: endTurn("回答") }]);
      const registry = new ToolRegistry();
      await registry.registerSource(sourceOf("builtin", [readTool]));
      const session = new AgentSession({
        provider,
        registry,
        host: t.host,
        engine: new PermissionEngine(),
        system: "sys",
        cwd: t.dir,
        retryDelaysMs: [1],
      });
      await session.run("当前会话");
      session.state.todos.push({ content: "旧清单", status: "in_progress" });
      session.state.filesRead.set("f", "hash");

      const lines = [
        { v: 1, type: "meta", sessionId: "s", createdAt: "t", cwd: t.dir },
        { v: 1, type: "message", message: { role: "user", content: "历史会话的问题" } },
      ] as const;
      const fakeStore = {
        append: async () => {},
        load: async () => [...lines],
      };
      session.applyResume(
        fakeStore,
        lines
          .filter((l): l is Extract<(typeof lines)[number], { type: "message" }> => l.type === "message")
          .map((l) => l.message),
      );
      expect(session.state.messages).toHaveLength(1);
      const first = session.state.messages[0];
      expect(first?.role === "user" && first.content).toBe("历史会话的问题");
      expect(session.state.todos).toHaveLength(0);
      expect(session.state.filesRead.size).toBe(0);

      // 后续消息写入新 store
      const provider2 = new FakeProvider([{ response: endTurn("新会话回答") }]);
      session.setProvider(provider2);
      await session.run("继续新会话");
      expect(provider2.requests[0]?.messages[0]).toEqual({
        role: "user",
        content: "历史会话的问题",
      });
    } finally {
      await t.cleanup();
    }
  });
});
