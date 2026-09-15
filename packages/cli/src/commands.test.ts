import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSession,
  PermissionEngine,
  ToolRegistry,
  configSchema,
  createFileLogger,
  readTool,
  sourceOf,
} from "@wcode/core";
import { FakeProvider, RecordingHost, endTurn, type FakeTurn } from "@wcode/core/testing";
import type { SkillDefinition } from "@wcode/core";
import { handleSlashCommand, type CommandDeps, type CommandSink } from "./commands";

function makeSink() {
  const notes: string[] = [];
  const errors: string[] = [];
  const assistant: string[] = [];
  const sink: CommandSink = {
    note: (t) => notes.push(t),
    assistant: (t) => assistant.push(t),
    error: (t) => errors.push(t),
  };
  return { sink, notes, errors, assistant };
}

const skills: SkillDefinition[] = [
  { name: "commit", description: "提交辅助", body: "按约定提交", source: "project", path: "/x" },
];

async function makeDeps(
  turns: FakeTurn[] = [],
  opts?: { skills?: SkillDefinition[] },
): Promise<{ deps: CommandDeps; host: RecordingHost; session: AgentSession }> {
  const provider = new FakeProvider(turns);
  const host = new RecordingHost();
  const registry = new ToolRegistry();
  await registry.registerSource(sourceOf("builtin", [readTool]));
  const session = new AgentSession({
    provider,
    registry,
    host,
    engine: new PermissionEngine(),
    system: "sys",
    cwd: tmpdir(),
    retryDelaysMs: [1],
  });
  const config = configSchema.parse({});
  const deps: CommandDeps = {
    session,
    skills: opts?.skills ?? skills,
    config,
    provider,
    createModelProvider: async (model) =>
      new FakeProvider([{ response: endTurn(`模型 ${model} 就绪`) }]),
    host,
    btwAbort: { current: null },
    sessionsDir: await mkdtemp(join(tmpdir(), "wcode-cmd-sessions-")),
    log: createFileLogger({ level: "error" }),
    reloadRuntime: async () => ({ config, skills: opts?.skills ?? skills, problems: [] }),
  };
  return { deps, host, session };
}

describe("handleSlashCommand", () => {
  it("/help 输出命令清单", async () => {
    const { deps } = await makeDeps();
    const { sink, assistant } = makeSink();
    const out = await handleSlashCommand("/help", deps, sink);
    expect(out.kind).toBe("handled");
    expect(assistant[0]).toContain("/compact");
    expect(assistant[0]).toContain("/goal");
    expect(assistant[0]).toContain("/btw");
  });

  it("/model 无参显示当前模型；带参切换并立即生效", async () => {
    const { deps, session } = await makeDeps();
    const { sink, notes } = makeSink();
    await handleSlashCommand("/model", deps, sink);
    expect(notes[0]).toContain("claude-sonnet-4-5");

    await handleSlashCommand("/model glm-5.3-flash", deps, sink);
    expect(notes[1]).toContain("glm-5.3-flash");
    expect(deps.config.model).toBe("glm-5.3-flash");
    // 切换后新 provider 立即接管后续请求
    const result = await session.run("hi");
    expect(result.reply).toBe("模型 glm-5.3-flash 就绪");
  });

  it("/skill 列表 / 调用 / 未知技能", async () => {
    const { deps } = await makeDeps();
    const { sink, notes, assistant, errors } = makeSink();

    await handleSlashCommand("/skill", deps, sink);
    expect(assistant[0]).toContain("**commit**（project）");

    const fwd = await handleSlashCommand("/skill commit 修复 lint", deps, sink);
    expect(fwd).toEqual({
      kind: "forward",
      text: expect.stringContaining('"commit"'),
    });
    expect((fwd as { text: string }).text).toContain("修复 lint");

    await handleSlashCommand("/skill ghost", deps, sink);
    expect(errors[0]).toContain('未知技能 "ghost"');

    const empty = await makeDeps([], { skills: [] });
    const s2 = makeSink();
    await handleSlashCommand("/skill", empty.deps, s2.sink);
    expect(s2.notes[0]).toContain("当前没有可用技能");
  });

  it("/init 映射为生成 AGENTS.md 的任务", async () => {
    const { deps } = await makeDeps();
    const out = await handleSlashCommand("/init", deps, makeSink().sink);
    expect(out.kind).toBe("forward");
    expect((out as { text: string }).text).toContain("AGENTS.md");
  });

  it("/btw 单轮直答：流式输出、不进入会话消息", async () => {
    const { deps, host, session } = await makeDeps([
      { response: endTurn("42 是答案") },
    ]);
    const out = await handleSlashCommand("/btw 这是什么", deps, makeSink().sink);
    expect(out.kind).toBe("handled");
    const deltas = host.eventsOfType("text_delta");
    expect(deltas.map((d) => d.text).join("")).toBe("42 是答案");
    expect(deps.btwAbort.current).toBeNull();
    expect(session.state.messages).toHaveLength(0); // 不进入任务上下文

    const s2 = makeSink();
    await handleSlashCommand("/btw", deps, s2.sink);
    expect(s2.errors[0]).toContain("用法");
  });

  it("/compact 手动压缩：摘要回填替换历史", async () => {
    const { deps, session } = await makeDeps([
      { response: endTurn("第一轮回答") },
      { response: endTurn("这是结构化摘要") },
    ]);
    await deps.session.run("做点事");
    const { sink, notes } = makeSink();
    const out = await handleSlashCommand("/compact", deps, sink);
    expect(out.kind).toBe("handled");
    expect(notes[0]).toContain("已压缩上下文");
    expect(session.state.messages[0]?.role).toBe("user");
    const first = session.state.messages[0];
    expect(first?.role === "user" && first.content).toContain("结构化摘要");
  });

  it("/goal 查看 / 设定 / 清除", async () => {
    const { deps, session } = await makeDeps();
    const { sink, notes } = makeSink();

    await handleSlashCommand("/goal", deps, sink);
    expect(notes[0]).toContain("未设定");

    await handleSlashCommand("/goal 完成重构并保持测试全绿", deps, sink);
    expect(notes[1]).toContain("完成重构并保持测试全绿");
    expect(session.getGoal()).toBe("完成重构并保持测试全绿");

    await handleSlashCommand("/goal", deps, sink);
    expect(notes[2]).toContain("当前目标");

    await handleSlashCommand("/goal clear", deps, sink);
    expect(session.getGoal()).toBeUndefined();
  });

  it("/技能名 与未知命令", async () => {
    const { deps } = await makeDeps();
    const { sink, errors } = makeSink();

    const fwd = await handleSlashCommand("/commit 顺手修 typo", deps, sink);
    expect(fwd.kind).toBe("forward");
    expect((fwd as { text: string }).text).toContain('"commit"');

    await handleSlashCommand("/foo", deps, sink);
    expect(errors[0]).toContain('未知命令 "/foo"');

    const plain = await handleSlashCommand("普通消息", deps, sink);
    expect(plain).toEqual({ kind: "forward", text: "普通消息" });
  });

  it("/reload 热重载：deps 的 config/skills 替换为快照", async () => {
    const { deps } = await makeDeps();
    const { sink, notes } = makeSink();
    let called = 0;
    const reloadedSkills: SkillDefinition[] = [
      { name: "new-skill", description: "新技能", body: "x", source: "project", path: "/n" },
    ];
    deps.reloadRuntime = async () => {
      called++;
      return { config: configSchema.parse({ model: "reloaded-model" }), skills: reloadedSkills, problems: ["技能 bad Name 名字不合法"] };
    };

    const out = await handleSlashCommand("/reload", deps, sink);
    expect(out.kind).toBe("handled");
    expect(called).toBe(1);
    expect(deps.config.model).toBe("reloaded-model");
    expect(deps.skills[0]?.name).toBe("new-skill");
    expect(notes[0]).toContain("已热重载");
    expect(notes[0]).toContain("警告");

    // 重载后的技能可被 /skill 列出
    const s2 = makeSink();
    await handleSlashCommand("/skill", deps, s2.sink);
    expect(s2.assistant[0]).toContain("new-skill");
  });

  it("/reload 失败时报错且不替换 deps", async () => {
    const { deps } = await makeDeps();
    const { sink, errors } = makeSink();
    const originalConfig = deps.config;
    deps.reloadRuntime = async () => {
      throw new Error("配置文件解析失败");
    };
    await handleSlashCommand("/reload", deps, sink);
    expect(errors[0]).toContain("重载失败");
    expect(deps.config).toBe(originalConfig);
  });

  it("/resume 无参列出历史会话，序号恢复切换消息历史", async () => {
    const { deps, session } = await makeDeps([
      { response: endTurn("旧回答") },
    ]);
    // 先制造一点当前会话历史
    await deps.session.run("当前会话的问题");
    expect(session.state.messages).toHaveLength(2);

    // 写两个历史会话文件
    const jsonl = (lines: string[]) => lines.join("\n") + "\n";
    await writeFile(
      join(deps.sessionsDir, "2026-09-15T08-00-00-000Z.jsonl"),
      jsonl([
        JSON.stringify({ v: 1, type: "meta", sessionId: "s-a", createdAt: "t", cwd: "/x" }),
        JSON.stringify({ v: 1, type: "message", message: { role: "user", content: "历史会话一的问题" } }),
        JSON.stringify({ v: 1, type: "message", message: { role: "assistant", text: "答一", toolCalls: [] } }),
      ]),
      "utf8",
    );
    await writeFile(
      join(deps.sessionsDir, "2026-09-15T09-00-00-000Z.jsonl"),
      jsonl([
        JSON.stringify({ v: 1, type: "meta", sessionId: "s-b", createdAt: "t", cwd: "/x" }),
        JSON.stringify({ v: 1, type: "message", message: { role: "user", content: "历史会话二的问题" } }),
      ]),
      "utf8",
    );

    const { sink, assistant, notes, errors } = makeSink();
    await handleSlashCommand("/resume", deps, sink);
    expect(assistant[0]).toContain("/resume <序号>");
    expect(assistant[0]).toContain("历史会话二的问题"); // 新的在前

    const out = await handleSlashCommand("/resume 1", deps, sink);
    expect(out.kind).toBe("handled");
    expect(notes[0]).toContain("已恢复会话");
    expect(session.state.messages).toHaveLength(1); // 替换为历史会话的消息
    const first = session.state.messages[0];
    expect(first?.role === "user" && first.content).toBe("历史会话二的问题");

    await handleSlashCommand("/resume 99", deps, sink);
    expect(errors[0]).toContain("序号需为 1-2");
  });

  it("/resume 无历史会话时给出提示", async () => {
    const { deps } = await makeDeps();
    const { sink, notes } = makeSink();
    await handleSlashCommand("/resume", deps, sink);
    expect(notes[0]).toContain("没有历史会话");
  });
});
