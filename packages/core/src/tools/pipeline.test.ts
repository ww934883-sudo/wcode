import { describe, expect, it } from "vitest";
import { ToolRegistry, sourceOf } from "./registry";
import { ToolExecutor } from "./pipeline";
import { defineTool } from "./tool";
import { PermissionEngine } from "../permission/engine";
import { z } from "zod";
import { makeSession, RecordingHost } from "../testing/fixtures";
import { createFileLogger } from "../logging/file-logger";
import { AbortedError } from "../errors";

function makeDeps(host: RecordingHost, engine: PermissionEngine, maxOutputChars = 30_000) {
  return {
    host,
    engine,
    log: createFileLogger({ level: "error" }),
    maxOutputChars,
  };
}

const echoTool = defineTool({
  name: "echo",
  description: "原样返回",
  schema: z.object({ text: z.string() }),
  isReadOnly: true,
  rulePatterns: (input) => [`echo(${input.text})`],
  execute: async (input) => ({ content: `echo: ${input.text}` }),
});

const slowTool = defineTool({
  name: "slow",
  description: "抛出中断",
  schema: z.object({}),
  isReadOnly: true,
  execute: async () => {
    throw new AbortedError();
  },
});

async function makeRegistry(tools = [echoTool, slowTool]): Promise<ToolRegistry> {
  const r = new ToolRegistry();
  await r.registerSource(sourceOf("test", tools));
  return r;
}

describe("ToolExecutor 管道", () => {
  it("未知工具返回教学式错误结果", async () => {
    const host = new RecordingHost();
    const ex = new ToolExecutor(await makeRegistry(), makeDeps(host, new PermissionEngine()));
    const r = await ex.execute({ id: "1", name: "nope", input: {} }, null as never);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("未知工具");
  });

  it("参数不合法返回可自纠的错误（不抛出）", async () => {
    const host = new RecordingHost();
    const ex = new ToolExecutor(await makeRegistry(), makeDeps(host, new PermissionEngine()));
    const r = await ex.execute({ id: "1", name: "echo", input: { wrong: 1 } }, null as never);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("参数不合法");
    expect(r.content).toContain("echo");
  });

  it("只读工具默认放行并执行", async () => {
    const host = new RecordingHost();
    const ex = new ToolExecutor(await makeRegistry(), makeDeps(host, new PermissionEngine()));
    const r = await ex.execute(
      { id: "1", name: "echo", input: { text: "hi" } },
      null as never,
    );
    expect(r.isError).toBe(false);
    expect(r.content).toBe("echo: hi");
    expect(host.events.filter((e) => e.type === "tool_end")).toHaveLength(1);
  });

  it("ask → 用户拒绝 → 错误结果，未执行", async () => {
    const host = new RecordingHost();
    host.permissionResponses.push("deny");
    // 变更类工具：用 write 语义（非只读）
    const mutating = defineTool({
      name: "write",
      description: "x",
      schema: z.object({ text: z.string() }),
      isReadOnly: false,
      execute: async () => ({ content: "executed!" }),
    });
    const ex = new ToolExecutor(await makeRegistry([mutating]), makeDeps(host, new PermissionEngine()));
    const r = await ex.execute({ id: "1", name: "write", input: { text: "a" } }, null as never);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("拒绝");
    expect(r.content).not.toContain("executed!");
    expect(host.permissionRequests).toHaveLength(1);
  });

  it("ask → allowAlways → 记入会话规则，第二次不再询问", async () => {
    const host = new RecordingHost();
    host.permissionResponses.push("allowAlways");
    const engine = new PermissionEngine();
    const mutating = defineTool({
      name: "write",
      description: "x",
      schema: z.object({ text: z.string() }),
      isReadOnly: false,
      execute: async (input) => ({ content: `did ${input.text}` }),
    });
    const session = makeSession("/tmp");
    const ex = new ToolExecutor(await makeRegistry([mutating]), makeDeps(host, engine));
    const r1 = await ex.execute({ id: "1", name: "write", input: { text: "a" } }, { session, signal: new AbortController().signal, log: createFileLogger({ level: "error" }) });
    expect(r1.isError).toBe(false);
    expect(engine.evaluate({ toolName: "write", isReadOnly: false, patterns: ["write"] }).decision).toBe("allow");

    host.permissionResponses.length = 0;
    const r2 = await ex.execute({ id: "2", name: "write", input: { text: "b" } }, { session, signal: new AbortController().signal, log: createFileLogger({ level: "error" }) });
    expect(r2.content).toBe("did b");
    expect(host.permissionRequests).toHaveLength(1); // 第二次没有再问
  });

  it("输出截断经过 truncate 阶段", async () => {
    const host = new RecordingHost();
    const ex = new ToolExecutor(await makeRegistry(), makeDeps(host, new PermissionEngine(), 50));
    const r = await ex.execute(
      { id: "1", name: "echo", input: { text: "x".repeat(500) } },
      null as never,
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain("输出已截断");
  });

  it("AbortedError 穿透管道不被吞掉", async () => {
    const host = new RecordingHost();
    const ex = new ToolExecutor(await makeRegistry(), makeDeps(host, new PermissionEngine()));
    await expect(
      ex.execute({ id: "1", name: "slow", input: {} }, null as never),
    ).rejects.toThrow(AbortedError);
  });

  it("中止时挂起的权限询问被解除，以中断收尾而非悬挂", async () => {
    const host = new RecordingHost();
    // 不预置 permissionResponses：宿主永不回答，模拟用户停在弹窗上按了中止
    const mutating = defineTool({
      name: "write",
      description: "x",
      schema: z.object({ text: z.string() }),
      isReadOnly: false,
      execute: async () => ({ content: "executed!" }),
    });
    const ex = new ToolExecutor(await makeRegistry([mutating]), makeDeps(host, new PermissionEngine()));
    const ac = new AbortController();
    const pending = ex.execute(
      { id: "1", name: "write", input: { text: "a" } },
      { session: makeSession("/tmp"), signal: ac.signal, log: createFileLogger({ level: "error" }) },
    );
    ac.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    expect(host.permissionRequests).toHaveLength(1);
  });
});
