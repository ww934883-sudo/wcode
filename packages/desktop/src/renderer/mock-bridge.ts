import type { AgentEvent, Message, PermissionDecision } from "@wcode/core";
import type {
  AutomationEntry,
  AutomationRunEntry,
  AutomationSpecInput,
  PermissionAsk,
  PermissionMode,
  RuntimeInfo,
  SearchHitEntry,
  ThinkingLevel,
  WcodeBridge,
} from "../shared/protocol";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const DEMO_MODELS = ["claude-sonnet-4-6", "glm-5.3-flash", "deepseek-v3"];
const CWD = "D:/demo-workspace";

/**
 * 浏览器预览模式：window.wcode 缺失时在页内回放演示叙事（与主进程
 * demo-script 同一套脚本），并模拟会话管理/搜索/设置等 v2 API，
 * 供 `pnpm --filter @wcode/desktop preview` 无头验证与视觉走查。
 */
export function createMockBridge(): WcodeBridge {
  interface MockSession {
    cwd: string;
    messages: Message[];
    aborted: boolean;
  }
  const sessions = new Map<string, MockSession>();
  const evSubs = new Set<(id: string, e: AgentEvent) => void>();
  const permSubs = new Set<(a: PermissionAsk) => void>();
  const infoSubs = new Set<(i: RuntimeInfo) => void>();
  const permWaiters = new Map<string, (d: PermissionDecision) => void>();
  let seq = 0;
  let permSeq = 0;
  let model = DEMO_MODELS[0] ?? "wcode-demo";
  let contextTokens = 200_000;
  let permissionMode: PermissionMode = "default";
  let thinkingLevel: ThinkingLevel = "medium";
  let persona: string | null = null;
  let mcpConnected = true;
  // 浏览器预览的用户级 MCP 配置（模拟 settings.json 的 mcpServers 节）
  const mockSettings: {
    mcpServers?: Record<string, { command: string; args: string[] }>;
  } = {
    mcpServers: {
      filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
    },
  };
  let notice: string | undefined =
    "浏览器预览模式：未连接 Electron 主进程，事件由页内脚本回放";

  // 浏览器预览的自动化是纯内存演示数据，不落库也不执行
  const automations: AutomationEntry[] = [];
  const autoRuns = new Map<string, AutomationRunEntry[]>();

  const seed = (id: string, title: string): void => {
    sessions.set(id, {
      cwd: CWD,
      messages: [
        { role: "user", content: title },
        {
          role: "assistant",
          text: `关于「${title}」的讨论结论：先做最小可行版本，再按反馈迭代。`,
          toolCalls: [],
        },
      ],
      aborted: false,
    });
  };
  seed("preview-h1", "生成式 UI 怎么落地");
  seed("preview-h2", "对比 evals 基线报告");

  const buildInfo = (): RuntimeInfo => {
    const byCwd = new Map<string, { id: string; title: string; time: string; messageCount: number }[]>();
    for (const [id, s] of sessions) {
      const firstUser = s.messages.find((m) => m.role === "user");
      const title =
        firstUser && firstUser.role === "user"
          ? firstUser.content.slice(0, 40)
          : "(空会话)";
      const list = byCwd.get(s.cwd) ?? [];
      list.push({ id, title, time: "刚刚", messageCount: s.messages.length });
      byCwd.set(s.cwd, list);
    }
    const projects = [...byCwd.entries()].map(([cwd, list]) => ({
      cwd,
      label: cwd.split(/[\\/]/).pop() || cwd,
      current: cwd === CWD,
      sessions: list,
    }));
    const messageCount = [...sessions.values()].reduce((n, s) => n + s.messages.length, 0);
    return {
      mode: "demo",
      providerName: "演示脚本（浏览器预览）",
      model,
      contextTokens,
      permissionMode,
      thinkingLevel,
      persona,
      currentCwd: CWD,
      projects,
      agents: [
        { name: "代码评审员", description: "审查改动、输出风险清单", source: "user" },
        { name: "测试工程师", description: "为改动补充测试用例", source: "user" },
      ],
      skills: [
        { name: "pdf", description: "处理 PDF 文档", source: "user" },
        { name: "docx", description: "生成 Word 文档", source: "project" },
      ],
      mcpServers: Object.entries(mockSettings.mcpServers ?? {}).map(([n, cfg]) => ({
        name: n,
        command: [cfg.command, ...cfg.args].join(" "),
        connected: mcpConnected,
      })),
      providers: [
        { name: "anthropic", type: "anthropic", hasKey: false, active: true },
        { name: "zhipu", type: "openai-compatible", hasKey: true, active: false },
      ],
      stats: { sessionCount: sessions.size, messageCount, inputTokens: 4523, outputTokens: 921 },
      notice,
    };
  };

  const emit = (sessionId: string, ev: AgentEvent): void => {
    for (const cb of evSubs) cb(sessionId, ev);
  };
  const ask = (sessionId: string, toolName: string, input: unknown, pattern: string) =>
    new Promise<PermissionDecision>((resolve) => {
      const id = `perm-mock-${++permSeq}`;
      permWaiters.set(id, resolve);
      for (const cb of permSubs) cb({ id, sessionId, toolName, input, patterns: [pattern] });
    });
  const bump = (): void => {
    const info = buildInfo();
    for (const cb of infoSubs) cb(info);
  };

  async function script(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.aborted = false;
    emit(sessionId, { type: "turn_start", turn: 1 });
    for (const c of ["好的，我先看一下这个项目的结构和说明。", "让我读一下 README……"]) {
      await sleep(70);
      if (session.aborted) return;
      emit(sessionId, { type: "text_delta", text: c });
    }
    emit(sessionId, {
      type: "tool_start",
      call: { id: `${sessionId}-t1`, name: "read", input: { file_path: `${CWD}/README.md` } },
    });
    await sleep(600);
    if (session.aborted) return;
    emit(sessionId, {
      type: "tool_end",
      callId: `${sessionId}-t1`,
      toolName: "read",
      ok: true,
      summary: "16 行",
      durationMs: 3,
    });
    session.messages.push({ role: "assistant", text: "好的，我先看一下这个项目的结构和说明。", toolCalls: [{ id: `${sessionId}-t1`, name: "read", input: { file_path: `${CWD}/README.md` } }] });
    session.messages.push({ role: "tool_result", results: [{ callId: `${sessionId}-t1`, content: "# demo-workspace…", isError: false }] });

    emit(sessionId, { type: "turn_start", turn: 2 });
    for (const c of [
      "看完了。这是演示用的示例工程。",
      "我把要点整理成一份笔记保存下来——这一步是**写文件**，你会先看到权限确认卡片。",
    ]) {
      await sleep(70);
      if (session.aborted) return;
      emit(sessionId, { type: "text_delta", text: c });
    }
    const input = {
      file_path: `${CWD}/演示笔记.md`,
      content: "# 演示笔记\n\n- 读文件 → 权限确认 → 写文件 → 汇报\n",
    };
    emit(sessionId, { type: "tool_start", call: { id: `${sessionId}-t2`, name: "write", input } });
    const decision = await ask(sessionId, "write", input, `Write(${CWD}/演示笔记.md)`);
    if (session.aborted) return;
    emit(sessionId, {
      type: "tool_end",
      callId: `${sessionId}-t2`,
      toolName: "write",
      ok: decision !== "deny",
      summary: decision === "deny" ? "用户拒绝，未写入" : "5 行已写入",
      durationMs: 2,
    });
    session.messages.push({
      role: "assistant",
      text: "看完了。我把要点整理成一份笔记保存下来。",
      toolCalls: [{ id: `${sessionId}-t2`, name: "write", input }],
    });
    session.messages.push({
      role: "tool_result",
      results: [{ callId: `${sessionId}-t2`, content: "已写入", isError: decision === "deny" }],
    });
    emit(sessionId, {
      type: "usage",
      usage: { inputTokens: 1234, outputTokens: 210 },
      cumulative: { inputTokens: 1234, outputTokens: 210 },
    });

    emit(sessionId, { type: "turn_start", turn: 3 });
    for (const c of [
      "笔记已经保存。",
      "到这里你看到了一个完整闭环：**流式回复 → 工具卡片 → 权限确认 → 结果汇报**。侧栏可以搜索/切换历史会话，顶栏可切模型/上下文/权限模式，右上 ⫿ 可分屏。",
    ]) {
      await sleep(70);
      if (session.aborted) return;
      emit(sessionId, { type: "text_delta", text: c });
    }
    session.messages.push({ role: "assistant", text: "笔记已经保存。演示闭环完成。", toolCalls: [] });
    emit(sessionId, { type: "done", reason: "end_turn" });
    bump();
  }

  const userIndexOfTurn = (messages: Message[], userTurn: number): number => {
    let seen = -1;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m && m.role === "user") {
        seen++;
        if (seen === userTurn) return i;
      }
    }
    return messages.length;
  };

  return {
    info: async () => buildInfo(),
    newSession: async (cwd) => {
      const id = `preview-${++seq}`;
      sessions.set(id, { cwd: cwd ?? CWD, messages: [], aborted: false });
      bump();
      return { sessionId: id, cwd: cwd ?? CWD };
    },
    openSession: async (cwd, sessionId) => {
      const s = sessions.get(sessionId) ?? { cwd, messages: [], aborted: false };
      return { sessionId, messages: [...s.messages] };
    },
    forkSession: async (cwd, sessionId, userTurn) => {
      const src = sessions.get(sessionId);
      const kept = src ? src.messages.slice(0, userIndexOfTurn(src.messages, userTurn)) : [];
      const id = `preview-${++seq}`;
      sessions.set(id, { cwd, messages: [...kept], aborted: false });
      bump();
      return { sessionId: id, messages: [...kept] };
    },
    rollbackSession: async (_cwd, sessionId, userTurn) => {
      const src = sessions.get(sessionId);
      if (src) {
        const cut = userIndexOfTurn(src.messages, userTurn);
        src.messages = src.messages.slice(0, cut);
        bump();
        return { sessionId, messages: [...src.messages] };
      }
      return { sessionId, messages: [] };
    },
    deleteSession: async (_cwd, sessionId) => {
      sessions.delete(sessionId);
      bump();
    },
    searchSessions: async (keyword) => {
      const hits: SearchHitEntry[] = [];
      for (const [id, s] of sessions) {
        s.messages.forEach((m, i) => {
          const text =
            m.role === "user" ? m.content : m.role === "assistant" ? m.text : null;
          if (text && text.includes(keyword)) {
            const at = text.indexOf(keyword);
            hits.push({
              sessionId: id,
              cwd: s.cwd,
              messageIndex: i + 1,
              role: m.role,
              excerpt: `${at > 20 ? "…" : ""}${text.slice(Math.max(0, at - 20), at + 50)}…`,
            });
          }
        });
      }
      return hits.slice(0, 30);
    },
    send: async (sessionId) => {
      void script(sessionId);
    },
    abort: async (sessionId) => {
      const s = sessions.get(sessionId);
      if (s) s.aborted = true;
    },
    decide: async (_sessionId, askId, decision) => {
      const resolve = permWaiters.get(askId);
      permWaiters.delete(askId);
      resolve?.(decision);
    },
    listModels: async () => DEMO_MODELS,
    setModel: async (m) => {
      model = m;
      bump();
    },
    setContextTokens: async (tokens) => {
      contextTokens = tokens;
      bump();
    },
    setPermissionMode: async (m) => {
      permissionMode = m;
      bump();
    },
    setThinkingLevel: async (l) => {
      thinkingLevel = l;
      bump();
    },
    setPersona: async (name) => {
      persona = name;
      bump();
    },
    pickFolder: async () => "D:/demo-workspace-2",
    saveProviderKey: async (name) => {
      notice = `已保存 ${name} 的 API key（浏览器预览为模拟数据）`;
      bump();
    },
    setActiveProvider: async (name) => {
      notice = `已切换服务商：${name}（浏览器预览为模拟数据）`;
      bump();
    },
    setMcpEnabled: async (_name, enabled) => {
      mcpConnected = enabled;
      bump();
    },
    addMcpServer: async (name, command, args, env) => {
      if (!name.trim()) throw new Error("请填写服务器名称");
      if (!command.trim()) throw new Error("请填写启动命令");
      const servers = mockSettings.mcpServers ?? {};
      if (name in servers) throw new Error(`用户级配置中已存在 MCP 服务器「${name}」`);
      servers[name] = { command: command.trim(), args };
      mockSettings.mcpServers = servers;
      mcpConnected = true;
      notice = `MCP ${name} 已添加并连接（浏览器预览为模拟数据）`;
      bump();
    },
    removeMcpServer: async (name) => {
      const servers = mockSettings.mcpServers ?? {};
      if (!(name in servers)) {
        throw new Error(`「${name}」不在用户级配置中（可能来自项目级 .wcode/settings.json）`);
      }
      delete servers[name];
      notice = `MCP ${name} 已删除（浏览器预览为模拟数据）`;
      bump();
    },
    listAutomations: async () => [...automations],
    addAutomation: async (spec: AutomationSpecInput) => {
      if (!spec.prompt.trim()) throw new Error("请填写任务提示词");
      if (spec.schedule.kind === "cron" && !spec.schedule.expr.trim()) {
        throw new Error("cron 调度需要表达式");
      }
      const now = Date.now();
      const id = `mock-auto-${++seq}`;
      const rec: AutomationEntry = {
        id,
        title: spec.title.trim() || spec.prompt.slice(0, 30),
        prompt: spec.prompt,
        cwd: spec.cwd,
        mode: spec.mode ?? "default",
        scheduleKind: spec.schedule.kind,
        cronExpr: spec.schedule.kind === "cron" ? spec.schedule.expr : null,
        runAt: spec.schedule.kind === "once" ? spec.schedule.runAt : null,
        timeoutMs: spec.timeoutMs ?? null,
        maxRuns: spec.maxRuns ?? null,
        runCount: 0,
        enabled: true,
        nextRunAt:
          spec.schedule.kind === "cron" ? now + 3_600_000 : (spec.schedule.runAt ?? null),
        lastRunAt: null,
        running: false,
        dispatchAttempts: 0,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      automations.unshift(rec);
      bump();
      return rec;
    },
    removeAutomation: async (id) => {
      const i = automations.findIndex((a) => a.id === id);
      if (i >= 0) automations.splice(i, 1);
      autoRuns.delete(id);
      bump();
    },
    setAutomationEnabled: async (id, enabled) => {
      const a = automations.find((x) => x.id === id);
      if (a) {
        a.enabled = enabled;
        a.updatedAt = Date.now();
      }
      bump();
    },
    runAutomation: async (id) => {
      const a = automations.find((x) => x.id === id);
      if (!a) return;
      const run: AutomationRunEntry = {
        id: `mock-run-${++seq}`,
        automationId: a.id,
        trigger: "manual",
        startedAt: Date.now(),
        finishedAt: Date.now() + 1200,
        outcome: "success",
        sessionId: null,
        error: null,
      };
      a.runCount++;
      a.lastRunAt = run.startedAt;
      autoRuns.set(a.id, [run, ...(autoRuns.get(a.id) ?? [])]);
      bump();
    },
    listAutomationRuns: async (id) => autoRuns.get(id) ?? [],
    onEvent: (cb) => {
      evSubs.add(cb);
      return () => evSubs.delete(cb);
    },
    onPermission: (cb) => {
      permSubs.add(cb);
      return () => permSubs.delete(cb);
    },
    onInfo: (cb) => {
      infoSubs.add(cb);
      return () => infoSubs.delete(cb);
    },
  };
}
