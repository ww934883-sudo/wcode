import type { Message, ToolCall, ToolResultBlock } from "../types";
import type { ModelProvider, ModelRequest, ModelResponse } from "../model/port";
import type { AgentHost, AgentEvent, PermissionDecision, PermissionRequest } from "../host/port";
import type { ToolRegistry } from "../tools/registry";
import { ToolExecutor } from "../tools/pipeline";
import type { ToolContext } from "../tools/tool";
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

  private readonly provider: ModelProvider;
  private readonly registry: ToolRegistry;
  private readonly host: AgentHost;
  private readonly systemPrompt: string;
  private readonly executor: ToolExecutor;
  private readonly store?: SessionStore;
  private readonly maxTurns: number;
  private readonly maxOutputChars: number;
  private readonly retryDelaysMs: number[];
  private readonly maxContextTokens: number;
  private readonly compactThreshold: number;
  private readonly bashTimeoutMs?: number;
  private readonly log: Logger;
  private abortController?: AbortController;

  constructor(opts: AgentSessionOptions) {
    this.provider = opts.provider;
    this.registry = opts.registry;
    this.host = opts.host;
    this.systemPrompt = opts.system;
    this.maxTurns = opts.maxTurns ?? MAX_TURNS_DEFAULT;
    this.maxOutputChars = opts.maxOutputChars ?? MAX_OUTPUT_CHARS_DEFAULT;
    this.retryDelaysMs = opts.retryDelaysMs ?? [...DEFAULT_RETRY_DELAYS_MS];
    this.maxContextTokens = opts.maxContextTokens ?? 200_000;
    this.compactThreshold = opts.compactThreshold ?? 0.8;
    this.bashTimeoutMs = opts.bashTimeoutMs;
    this.log = opts.log ?? createFileLogger();
    this.store = opts.store;
    this.state = createSessionState(opts.cwd);
    this.executor = new ToolExecutor(this.registry, {
      host: opts.host,
      engine: opts.engine,
      log: this.log,
      maxOutputChars: this.maxOutputChars,
    });
  }

  abort(): void {
    this.abortController?.abort();
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
      system: this.systemPrompt,
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
      estimateTokens(this.systemPrompt) + estimateMessagesTokens(this.state.messages);
    if (estimated <= this.maxContextTokens * this.compactThreshold) return;

    let summary: string | null = null;
    try {
      summary = await this.summarize();
    } catch (err) {
      if (isAbortedError(err)) throw err;
      this.host.emit({
        type: "error",
        message: `上下文压缩失败（${err instanceof Error ? err.message : String(err)}），本次跳过继续任务`,
      });
      return;
    }

    const kept = this.state.messages.slice(-2);
    const inject: Message = {
      role: "user",
      content: `[系统提示：上下文已压缩。以下是此前进展的结构化摘要，请基于它继续任务]\n\n${summary}`,
    };
    this.state.messages = [inject, ...kept];
    const note = `已压缩上下文：约 ${estimated} tokens → ${estimateTokens(this.systemPrompt) + estimateMessagesTokens(this.state.messages)} tokens`;
    this.host.emit({ type: "compacted", note });
    await this.store
      ?.append({ v: 1, type: "event", event: { type: "compacted", note } })
      .catch(() => {});
  }

  private async summarize(): Promise<string> {
    const rendered = renderConversationForSummary(this.state.messages);
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
