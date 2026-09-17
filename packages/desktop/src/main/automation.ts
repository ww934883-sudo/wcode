import {
  AgentSession,
  AutomationStore,
  PermissionEngine,
  parseRuleString,
  type AutomationOutcome,
  type AutomationRecord,
  type Logger,
  type ModelProvider,
  type PermissionMode,
  type SessionDriver,
  type ToolRegistry,
} from "@wcode/core";
import type { AutomationEntry, AutomationRunEntry, AutomationSpecInput } from "../shared/protocol";

/**
 * 桌面端自动化调度台：core AutomationStore（SQLite ~/.wcode/wcode.db，与 CLI
 * daemon 共库）+ 主进程内置 tick + 进程内执行。不开子进程——桌面主进程本身就是
 * 长驻宿主，直接装配一次 headless AgentSession 跑完一轮；权限询问自动拒绝
 * （无人值守没有用户可问，权限模式仍按任务配置的 mode 放行对应操作）。
 */
export interface AutomationDeps {
  homeDir: string;
  /** 按任务 cwd 构造 provider（demo 模式返回脚本 provider） */
  providerFor(cwd: string): ModelProvider;
  /** 共享工具注册表（含已连接 MCP） */
  registry(): ToolRegistry;
  /** 系统提示（含助理人设） */
  systemFor(cwd: string): string;
  /** 用户配置的权限规则（allow/deny 字符串） */
  permissionRules(): { allow: string[]; deny: string[] };
  /** 会话驱动缓存（jsonl，任务会话对 CLI 可见） */
  driverFor(cwd: string): Promise<SessionDriver>;
  /** 当前思考级别偏好 */
  thinking(): "off" | "low" | "medium" | "high";
  /** 状态变更通知（刷新渲染层 info） */
  onChanged(): void;
  log?: Logger;
}

const PERMISSION_MODES: PermissionMode[] = ["plan", "default", "acceptEdits", "bypass"];

function toEntry(r: AutomationRecord): AutomationEntry {
  return {
    id: r.id,
    title: r.title,
    prompt: r.prompt,
    cwd: r.cwd,
    mode: r.mode,
    scheduleKind: r.scheduleKind,
    cronExpr: r.cronExpr,
    runAt: r.runAt,
    timeoutMs: r.timeoutMs,
    maxRuns: r.maxRuns,
    runCount: r.runCount,
    enabled: r.enabled,
    nextRunAt: r.nextRunAt,
    lastRunAt: r.lastRunAt,
    running: r.running,
    dispatchAttempts: r.dispatchAttempts,
    lastError: r.lastError,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export class AutomationDesk {
  private store: AutomationStore | null = null;
  private storeError: string | null = null;
  private opening: Promise<AutomationStore> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly deps: AutomationDeps) {}

  /** 惰性开库：node:sqlite 在 Electron 内置 Node 可用（实测 v22.22）；失败降级为错误提示 */
  private async ready(): Promise<AutomationStore> {
    if (this.store) return this.store;
    if (this.storeError) throw new Error(this.storeError);
    if (!this.opening) {
      this.opening = AutomationStore.open({ homeDir: this.deps.homeDir, log: this.deps.log })
        .then((s) => {
          this.store = s;
          return s;
        })
        .catch((err) => {
          this.storeError = `自动化存储不可用（${err instanceof Error ? err.message : String(err)}）`;
          throw new Error(this.storeError);
        });
    }
    return this.opening;
  }

  /** 启动调度器（60s 一轮，与应用同生命周期） */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.store?.close();
    this.store = null;
    this.opening = null;
  }

  /** 一轮调度：扫描到期 → 顺序执行（claim 互斥保证与 CLI daemon 不双跑） */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let ran = 0;
    try {
      const store = await this.ready();
      for (const a of store.due()) {
        await this.execute(a.id, "schedule");
        ran++;
      }
    } catch {
      // 存储不可用等：静默等下一轮（错误已记录，页面可见）
    } finally {
      this.ticking = false;
    }
    return ran;
  }

  async list(): Promise<AutomationEntry[]> {
    const store = await this.ready();
    return store.list().map(toEntry);
  }

  async runs(id: string): Promise<AutomationRunEntry[]> {
    const store = await this.ready();
    return store.runs(store.get(id).id);
  }

  async add(spec: AutomationSpecInput): Promise<AutomationEntry> {
    const title = spec.title.trim();
    const prompt = spec.prompt.trim();
    const cwd = spec.cwd.trim();
    if (!title) throw new Error("请填写任务名称");
    if (!prompt) throw new Error("请填写任务提示词");
    if (!cwd) throw new Error("请选择执行目录");
    const mode = PERMISSION_MODES.includes(spec.mode as PermissionMode)
      ? (spec.mode as PermissionMode)
      : "default";
    const timeoutMs = spec.timeoutMs && spec.timeoutMs > 0 ? Math.round(spec.timeoutMs) : undefined;
    const maxRuns = spec.maxRuns && spec.maxRuns > 0 ? Math.round(spec.maxRuns) : undefined;
    const store = await this.ready();
    const rec = store.add({
      title,
      prompt,
      cwd,
      mode,
      schedule: spec.schedule,
      timeoutMs,
      maxRuns,
    });
    this.deps.onChanged();
    return toEntry(rec);
  }

  async remove(id: string): Promise<void> {
    (await this.ready()).remove(id);
    this.deps.onChanged();
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    (await this.ready()).setEnabled(id, enabled);
    this.deps.onChanged();
  }

  /** 手动立即执行一次（渲染层后台触发；错误抛回调用方展示） */
  async runManually(id: string): Promise<void> {
    const store = await this.ready();
    const rec = store.get(id);
    await this.execute(rec.id, "manual");
  }

  /**
   * 执行一次：claim 互斥 → startRun → headless 会话跑一轮 → finishRun。
   * 模型失败（含非可重试 ProviderError）记为 failed 运行并推进调度；
   * 基础设施异常走 failRun + 退避，不消耗调度节奏。
   */
  private async execute(id: string, trigger: "schedule" | "manual"): Promise<void> {
    const store = await this.ready();
    const a = store.get(id);
    if (!store.claim(a.id)) {
      if (trigger === "manual") {
        throw new Error(`「${a.title}」正在运行（可能被 daemon 持有），稍后再试`);
      }
      return;
    }
    const { run } = store.startRun(a.id, trigger);
    this.deps.onChanged();
    const driver = await this.deps.driverFor(a.cwd);
    const { sessionId, store: sessionStore } = await driver.createNew({ cwd: a.cwd });
    const rules = this.deps.permissionRules();
    const engine = new PermissionEngine({
      rules: [
        ...rules.allow.map((s) => parseRuleString(s, "allow", "config")),
        ...rules.deny.map((s) => parseRuleString(s, "deny", "config")),
      ],
      mode: PERMISSION_MODES.includes(a.mode as PermissionMode)
        ? (a.mode as PermissionMode)
        : "default",
    });
    const session = new AgentSession({
      provider: this.deps.providerFor(a.cwd),
      registry: this.deps.registry(),
      // 无人值守宿主：事件不投递、权限询问一律拒绝
      host: { emit: () => {}, requestPermission: async () => "deny" },
      engine,
      system: this.deps.systemFor(a.cwd),
      cwd: a.cwd,
      store: sessionStore,
      thinking: this.deps.thinking(),
      maxTurns: 25,
    });
    let timedOut = false;
    const timer =
      a.timeoutMs && a.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            session.abort();
          }, a.timeoutMs)
        : undefined;
    try {
      const result = await session.run(a.prompt);
      const outcome: AutomationOutcome = timedOut
        ? "timeout"
        : result.status === "end_turn"
          ? "success"
          : result.status === "max_turns"
            ? "max_turns"
            : "aborted";
      store.finishRun(run.id, { outcome, sessionId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.finishRun(run.id, { outcome: "failed", sessionId, error: msg });
      if (trigger === "manual") throw err;
    } finally {
      if (timer) clearTimeout(timer);
      this.deps.onChanged();
    }
  }
}
