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
