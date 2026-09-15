import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSession,
  PermissionEngine,
  ToolRegistry,
  builtinToolSource,
  buildSystemPrompt,
  defaultPromptSections,
  type ModelProvider,
} from "@wcode/core";
import { gradeAll } from "./grader";
import type { EvalTask, EvalTaskResult, SuiteReport } from "./types";

export interface EvalRunOptions {
  provider: ModelProvider;
  /** 覆盖默认 system prompt */
  system?: string;
  maxTurns?: number;
  /** 单任务墙钟超时（到点 abort），默认 5 分钟 */
  taskTimeoutMs?: number;
  /** 失败时保留工作区以便排查 */
  keepWorkspaces?: boolean;
}

export const SUITE_NAME = "wcode-core-v1";

/** 评测以无人值守方式运行：权限全放行（bypass 模式的正式用武之地） */
const silentHost = {
  emit: () => {},
  requestPermission: () => Promise.resolve("allow" as const),
};

async function seedWorkspace(files?: Record<string, string>): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "wcode-eval-"));
  for (const [rel, content] of Object.entries(files ?? {})) {
    const abs = join(workspace, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return workspace;
}

export async function runEvalTask(
  task: EvalTask,
  opts: EvalRunOptions,
): Promise<EvalTaskResult> {
  const startedAt = Date.now();
  const workspace = await seedWorkspace(task.files);
  const base: EvalTaskResult = {
    id: task.id,
    title: task.title,
    category: task.category,
    pass: false,
    status: "failed",
    durationMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    turns: 0,
    failedChecks: [],
  };

  try {
    const registry = new ToolRegistry();
    await registry.registerSource(builtinToolSource);
    const session = new AgentSession({
      provider: opts.provider,
      registry,
      host: silentHost,
      engine: new PermissionEngine({ mode: "bypass" }),
      system:
        opts.system ??
        buildSystemPrompt(defaultPromptSections, {
          cwd: workspace,
          platform: process.platform,
        }),
      cwd: workspace,
      maxTurns: opts.maxTurns ?? 30,
      bashTimeoutMs: 60_000,
    });

    const timer = setTimeout(() => session.abort(), opts.taskTimeoutMs ?? 300_000);
    let run;
    try {
      run = await session.run(task.prompt);
    } finally {
      clearTimeout(timer);
    }
    base.tokensIn = session.state.cumulativeUsage.inputTokens;
    base.tokensOut = session.state.cumulativeUsage.outputTokens;
    base.turns = session.state.messages.filter((m) => m.role === "user").length;

    if (run.status === "aborted") {
      base.status = "timeout";
      base.error = `任务超时被中断（${opts.taskTimeoutMs ?? 300_000}ms）`;
      return await finish(task, base, workspace, opts, startedAt);
    }
    if (run.status === "max_turns") {
      base.error = `达到最大轮数（${opts.maxTurns ?? 30}）仍未完成`;
      return await finish(task, base, workspace, opts, startedAt);
    }

    const failedChecks = await gradeAll(workspace, task.checks);
    base.failedChecks = failedChecks;
    base.status = failedChecks.length === 0 ? "passed" : "failed";
    base.pass = failedChecks.length === 0;
    return await finish(task, base, workspace, opts, startedAt);
  } catch (err) {
    base.status = "error";
    base.error = err instanceof Error ? err.message : String(err);
    return await finish(task, base, workspace, opts, startedAt);
  }
}

async function finish(
  task: EvalTask,
  result: EvalTaskResult,
  workspace: string,
  opts: EvalRunOptions,
  startedAt: number,
): Promise<EvalTaskResult> {
  result.durationMs = Date.now() - startedAt;
  const keep = opts.keepWorkspaces === true || (result.status !== "passed" && opts.keepWorkspaces !== false);
  if (keep && result.status !== "passed") {
    result.workspace = workspace;
  } else {
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(
      () => {},
    );
  }
  return result;
}

export async function runSuite(
  tasks: EvalTask[],
  opts: EvalRunOptions & { model: string; providerId: string },
): Promise<SuiteReport> {
  const startedAt = new Date().toISOString();
  const results: EvalTaskResult[] = [];
  for (const task of tasks) {
    results.push(await runEvalTask(task, opts));
  }
  return {
    suite: SUITE_NAME,
    startedAt,
    finishedAt: new Date().toISOString(),
    model: opts.model,
    provider: opts.providerId,
    results,
    passed: results.filter((r) => r.pass).length,
    total: results.length,
  };
}

export interface CompareSummary {
  regressions: string[];
  fixed: string[];
  baselinePassRate: string;
  currentPassRate: string;
}

/** 与基线报告对比：按任务 id 对齐，找出回退与修复 */
export function compareReports(
  baseline: SuiteReport,
  current: SuiteReport,
): CompareSummary {
  const baselinePass = new Map(baseline.results.map((r) => [r.id, r.pass]));
  const regressions: string[] = [];
  const fixed: string[] = [];
  for (const r of current.results) {
    const was = baselinePass.get(r.id);
    if (was === true && !r.pass) regressions.push(r.id);
    if (was === false && r.pass) fixed.push(r.id);
  }
  return {
    regressions,
    fixed,
    baselinePassRate: `${baseline.passed}/${baseline.total}`,
    currentPassRate: `${current.passed}/${current.total}`,
  };
}
