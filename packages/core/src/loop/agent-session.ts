import type { Message, ToolCall, ToolResultBlock } from "../types";
import type { ModelProvider, ModelRequest, ModelResponse } from "../model/port";
import type { AgentHost, AgentEvent, PermissionDecision, PermissionRequest } from "../host/port";
import { ToolRegistry, sourceOf } from "../tools/registry";
import { ToolExecutor, type HookFn } from "../tools/pipeline";
import type { ToolContext } from "../tools/tool";
import type { SubAgentTask } from "../tools/builtin/task";
import { PermissionEngine } from "../permission/engine";
import type { SessionState } from "../session/state";
import { createSessionState } from "../session/state";
import type { SessionStore } from "../session/store";
import type { Logger } from "../logging/port";
import { ProviderError, isAbortedError } from "../errors";
import { createFileLogger } from "../logging/file-logger";
import { microCleanMessages } from "../context/micro-clean";
import {
  SUMMARY_SYSTEM_PROMPT,
  buildSummaryPrompt,
  estimateMessagesTokens,
  estimateTokens,
  renderConversationForSummary,
} from "../context/compact";
import {
  DEFAULT_RETRY_DELAYS_MS,
  MAX_OUTPUT_CHARS_DEFAULT,
  MAX_TURNS_DEFAULT,
  sleepInterruptible,
} from "./retry";
import { runHooks } from "../hooks/hooks";
import type { HooksConfig } from "../config/schema";
import type { CustomAgentDef } from "../agents/defs";

export interface AgentSessionOptions {
  provider: ModelProvider;
  registry: ToolRegistry;
  host: AgentHost;
  engine: PermissionEngine;
  /** 已组装好的 system prompt */
  system: string;
  cwd: string;
  store?: SessionStore;
  maxTurns?: number;
  maxOutputChars?: number;
  /** 重试延迟序列，测试注入短值 */
  retryDelaysMs?: number[];
  log?: Logger;
  /** 上下文窗口大小（token 估算），超过 threshold 比例触发压缩 */
  maxContextTokens?: number;
  compactThreshold?: number;
  /** Bash 工具默认超时（透传 ToolContext） */
  bashTimeoutMs?: number;
  /** 会话恢复：重放的既有消息历史 */
  initialMessages?: Message[];
  /** lifecycle hooks 配置（M2）：pre/post 工具事件注入工具管道 */
  hooks?: HooksConfig;
  /** 自定义子 Agent 定义（M2）：task 工具按 subagent 名解析 */
  customAgents?: CustomAgentDef[];
}

export interface RunResult {
  status: "end_turn" | "max_turns" | "aborted";
  /** 模型最后一条文本（中断/超轮时为已有进展的最后发言） */
  reply: string;
}

/**
 * Agent 主循环状态机（架构文档 §3.1）。
 * 对外控制面只有 run() 与 abort()；工具错误不终止循环，
 * 只有不可重试的 ProviderError 会向上抛。
 */
export class AgentSession {
  readonly state: SessionState;

  private provider: ModelProvider;
  private readonly registry: ToolRegistry;
  private readonly host: AgentHost;
  private readonly systemPrompt: string;
  private goal?: string;
  private readonly executor: ToolExecutor;
  private readonly store?: SessionStore;
  private readonly maxTurns: number;
  private readonly maxOutputChars: number;
  private readonly retryDelaysMs: number[];
  private readonly maxContextTokens: number;
  private readonly compactThreshold: number;
  private readonly bashTimeoutMs?: number;
  private readonly engine: PermissionEngine;
  private readonly log: Logger;
  private readonly hooks?: HooksConfig;
  private readonly customAgents: CustomAgentDef[];
  private abortController?: AbortController;

  constructor(opts: AgentSessionOptions) {
    this.provider = opts.provider;
    this.registry = opts.registry;
    this.host = opts.host;
    this.systemPrompt = opts.system;
    this.engine = opts.engine;
    this.maxTurns = opts.maxTurns ?? MAX_TURNS_DEFAULT;
    this.maxOutputChars = opts.maxOutputChars ?? MAX_OUTPUT_CHARS_DEFAULT;
    this.retryDelaysMs = opts.retryDelaysMs ?? [...DEFAULT_RETRY_DELAYS_MS];
    this.maxContextTokens = opts.maxContextTokens ?? 200_000;
    this.compactThreshold = opts.compactThreshold ?? 0.8;
    this.bashTimeoutMs = opts.bashTimeoutMs;
    this.log = opts.log ?? createFileLogger();
    this.store = opts.store;
    this.hooks = opts.hooks;
    this.customAgents = opts.customAgents ?? [];
    this.state = createSessionState(opts.cwd);
    if (opts.initialMessages && opts.initialMessages.length > 0) {
      this.state.messages = [...opts.initialMessages];
    }
    this.executor = new ToolExecutor(this.registry, {
      host: opts.host,
      engine: opts.engine,
      log: this.log,
      maxOutputChars: this.maxOutputChars,
      hookPre: this.makeHookFn("pre_tool_use"),
      hookPost: this.makeHookFn("post_tool_use"),
    });
  }

  /** hooks 配置 → 工具管道 HookFn；未配置对应事件时返回 undefined（零开销） */
  private makeHookFn(event: "pre_tool_use" | "post_tool_use"): HookFn | undefined {
    const hooks = this.hooks;
    if (!hooks) return undefined;
    const defs = event === "pre_tool_use" ? hooks.preToolUse : hooks.postToolUse;
    if (defs.length === 0) return undefined;
    return async ({ toolName, input, signal }) => {
      const outcome = await runHooks(
        event,
        hooks,
        { toolName, toolInput: input, cwd: this.state.cwd },
        { cwd: this.state.cwd, signal },
      );
      for (const notice of outcome.notices) {
        this.log.warn("hook.notice", { event, tool: toolName, notice });
      }
      if (outcome.blocked !== undefined) {
        return { block: true, reason: outcome.blocked };
      }
      return undefined;
    };
  }

  abort(): void {
    this.abortController?.abort();
  }

  /** 运行期切换模型 provider（/model），下一轮请求立即生效 */
  setProvider(provider: ModelProvider): void {
    this.provider = provider;
  }

  /** /goal 设定任务目标：并入 effective system prompt，压缩上下文后依然有效 */
  setGoal(goal: string | undefined): void {
    const trimmed = goal?.trim();
    this.goal = trimmed ? trimmed : undefined;
  }

  getGoal(): string | undefined {
    return this.goal;
  }

  private effectiveSystem(): string {
    return this.goal
      ? `${this.systemPrompt}\n\n[当前任务目标（用户以 /goal 设定，全程有效，完成前不要偏离）]\n${this.goal}`
      : this.systemPrompt;
  }

  async run(input: string): Promise<RunResult> {
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    await this.pushMessage({ role: "user", content: input });

    let lastText = "";
    try {
      for (let turn = 1; turn <= this.maxTurns; turn++) {
        this.host.emit({ type: "turn_start", turn });

        await this.maybeCompact();
        const res = await this.callModel(signal);
        lastText = res.text;
        await this.pushMessage({
          role: "assistant",
          text: res.text,
          toolCalls: res.toolCalls,
          usage: res.usage,
        });

        if (res.stopReason !== "tool_use") {
          this.host.emit({ type: "done", reason: "end_turn" });
          return { status: "end_turn", reply: res.text };
        }

        const results = await this.runToolBatch(res.toolCalls, signal);
        await this.pushMessage({ role: "tool_result", results });
      }
      this.host.emit({ type: "done", reason: "max_turns" });
      return { status: "max_turns", reply: lastText };
    } catch (err) {
      if (isAbortedError(err)) {
        this.host.emit({ type: "done", reason: "aborted" });
        return { status: "aborted", reply: lastText };
      }
      throw err;
    }
  }

  private async callModel(signal: AbortSignal): Promise<ModelResponse> {
    const req: ModelRequest = {
      system: this.effectiveSystem(),
      // 微清理：较老的大体积工具结果替换为占位符（不改会话原数据）
      messages: microCleanMessages(this.state.messages),
      tools: this.registry.toDefs(),
      maxTokens: 8192,
      signal,
    };

    for (let attempt = 0; ; attempt++) {
      try {
        let response: ModelResponse | undefined;
        for await (const ev of this.provider.stream(req)) {
          if (ev.type === "text_delta") {
            this.host.emit({ type: "text_delta", text: ev.text });
          } else {
            response = ev.response;
          }
        }
        if (!response) {
          throw new ProviderError("模型流意外结束（未收到完整响应）", {
            retryable: true,
          });
        }
        this.state.cumulativeUsage.inputTokens += response.usage.inputTokens;
        this.state.cumulativeUsage.outputTokens += response.usage.outputTokens;
        this.host.emit({
          type: "usage",
          usage: response.usage,
          cumulative: { ...this.state.cumulativeUsage },
        });
        return response;
      } catch (err) {
        const retryable =
          err instanceof ProviderError && err.retryable && !signal.aborted;
        const delay = this.retryDelaysMs[attempt];
        if (retryable && delay !== undefined) {
          this.host.emit({
            type: "error",
            message: `模型请求失败（${err instanceof Error ? err.message : String(err)}），${Math.round(delay / 1000)}s 后重试（第 ${attempt + 1} 次）`,
          });
          await sleepInterruptible(delay, signal);
          continue;
        }
        throw err;
      }
    }
  }

  private async runToolBatch(
    calls: ToolCall[],
    signal: AbortSignal,
  ): Promise<ToolResultBlock[]> {
    const ctx: ToolContext = {
      session: this.state,
      signal,
      log: this.log,
      emitEvent: (event) => this.host.emit(event),
      bashTimeoutMs: this.bashTimeoutMs,
      spawn: (task) => this.runSubAgent(task),
    };
    // 批内并发规则：全只读 → 并行；含任何写操作 → 按声明顺序串行
    const allReadOnly = calls.every(
      (c) => this.registry.get(c.name)?.isReadOnly === true,
    );
    for (const call of calls) {
      this.host.emit({ type: "tool_start", call });
    }
    if (allReadOnly && calls.length > 1) {
      return Promise.all(calls.map((c) => this.executor.execute(c, ctx)));
    }
    const out: ToolResultBlock[] = [];
    for (const call of calls) {
      out.push(await this.executor.execute(call, ctx));
    }
    return out;
  }

  private async pushMessage(message: Message): Promise<void> {
    this.state.messages.push(message);
    if (this.store) {
      await this.store.append({ v: 1, type: "message", message });
    }
  }

  /**
   * 上下文压缩（架构文档 §4·第二层）：token 估算超过阈值时，
   * 用模型生成结构化摘要替换旧历史，保留最近 2 条消息原文。
   * 摘要失败不阻断任务（跳过本次压缩，仅提示）。
   */
  private async maybeCompact(): Promise<void> {
    const estimated =
      estimateTokens(this.effectiveSystem()) + estimateMessagesTokens(this.state.messages);
    if (estimated <= this.maxContextTokens * this.compactThreshold) return;

    try {
      await this.rebuildWithSummary();
    } catch (err) {
      if (isAbortedError(err)) throw err;
      this.host.emit({
        type: "error",
        message: `上下文压缩失败（${err instanceof Error ? err.message : String(err)}），本次跳过继续任务`,
      });
    }
  }

  /** /compact 手动压缩：跳过阈值判断，直接对当前历史做摘要回填 */
  async compactNow(): Promise<string> {
    if (this.state.messages.length === 0) {
      return "当前没有历史消息，无需压缩。";
    }
    return await this.rebuildWithSummary();
  }

  private async rebuildWithSummary(): Promise<string> {
    const before =
      estimateTokens(this.effectiveSystem()) + estimateMessagesTokens(this.state.messages);
    const summary = await this.summarize();

    const kept = this.state.messages.slice(-2);
    const inject: Message = {
      role: "user",
      content: `[系统提示：上下文已压缩。以下是此前进展的结构化摘要，请基于它继续任务]\n\n${summary}`,
    };
    this.state.messages = [inject, ...kept];
    const after =
      estimateTokens(this.effectiveSystem()) + estimateMessagesTokens(this.state.messages);
    const note = `已压缩上下文：约 ${before} tokens → ${after} tokens`;
    this.host.emit({ type: "compacted", note });
    await this.store
      ?.append({ v: 1, type: "event", event: { type: "compacted", note } })
      .catch(() => {});
    return note;
  }

  /**
   * 子 Agent（架构文档 §2.8 扩展点）：全新消息数组 + 工具子集 + 继承权限引擎，
   * 只把最终文本返回主对话。子 Agent 不再派生（防止递归），轮数上限更低。
   * M2：subagent 名命中自定义定义时，用其正文作 system prompt、按定义收敛工具集。
   */
  private async runSubAgent(task: SubAgentTask): Promise<string> {
    const custom = task.subagent
      ? this.customAgents.find((a) => a.name === task.subagent)
      : undefined;
    if (task.subagent && !custom) {
      const catalog =
        this.customAgents
          .map((a) => `${a.name}（${a.description}）`)
          .join("；") || "（当前没有自定义子 Agent 定义）";
      return `未知子 Agent "${task.subagent}"。可用子 Agent: ${catalog}。请从列表中选择，或去掉 subagent 参数使用默认子 Agent。`;
    }

    const all = this.registry.list();
    let childTools = all.filter((t) =>
      task.tools === "all" ? t.name !== "task" : t.isReadOnly && t.name !== "task",
    );
    if (custom && Array.isArray(custom.tools)) {
      // 按定义收敛到指定工具名；task 一律剔除（防递归），未知名静默丢弃
      const wanted = new Set(custom.tools);
      childTools = all.filter((t) => wanted.has(t.name) && t.name !== "task");
    }
    const childRegistry = new ToolRegistry();
    await childRegistry.registerSource(sourceOf("subagent", childTools));

    const system = custom
      ? `你是「${custom.name}」子 Agent。${custom.body}\n\n` +
        "当前任务：\n\n" +
        `${task.prompt}\n\n` +
        "完成后用简洁文本汇报结论（主 Agent 只能看到这段汇报，看不到你的执行过程）。"
      : "你是被主 Agent 派出的子 Agent，专注完成以下任务：\n\n" +
        `${task.prompt}\n\n` +
        "完成后用简洁文本汇报结论（主 Agent 只能看到这段汇报，看不到你的执行过程）。";

    const childSession = new AgentSession({
      provider: this.provider,
      registry: childRegistry,
      host: {
        // 过程事件转发给 UI（文本增量不转发，避免与主输出交错）
        emit: (event) => {
          if (
            event.type === "tool_start" ||
            event.type === "tool_end" ||
            event.type === "error" ||
            event.type === "compacted"
          ) {
            this.host.emit(event);
          }
        },
        // 写操作仍需用户确认：子 Agent 的权限询问透传给宿主 UI
        requestPermission: (req) => this.host.requestPermission(req),
      },
      engine: this.engine,
      system,
      cwd: this.state.cwd,
      maxTurns: 25,
      retryDelaysMs: this.retryDelaysMs,
      log: this.log,
      maxContextTokens: this.maxContextTokens,
      compactThreshold: this.compactThreshold,
      bashTimeoutMs: this.bashTimeoutMs,
      // hooks 对子 Agent 同样生效（护栏不应被子任务绕过）
      hooks: this.hooks,
    });
    const result = await childSession.run(task.prompt);
    return result.reply || "(子 Agent 无输出)";
  }

  private async summarize(): Promise<string> {    const rendered = renderConversationForSummary(this.state.messages);
    const req: ModelRequest = {
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildSummaryPrompt(rendered) }],
      tools: [],
      maxTokens: 4096,
      signal: this.abortController?.signal ?? new AbortController().signal,
    };
    let text = "";
    let response: ModelResponse | undefined;
    for await (const ev of this.provider.stream(req)) {
      if (ev.type === "text_delta") text += ev.text;
      else response = ev.response;
    }
    const summary = response?.text ?? text;
    if (!summary.trim()) {
      throw new ProviderError("摘要为空", { retryable: false });
    }
    return summary.trim();
  }
}

export type { AgentEvent, PermissionDecision, PermissionRequest };
