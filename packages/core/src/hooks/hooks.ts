import { spawn } from "node:child_process";
import type { HooksConfig, HookDef } from "../config/schema";

export type HookEvent = "session_start" | "pre_tool_use" | "post_tool_use";

export interface HookOutcome {
  /** 仅 pre_tool_use：阻断原因（hook 以退出码 2 表达） */
  blocked?: string;
  /** 非致命问题（非 0/2 退出、超时），记录告警但不阻断流程 */
  notices: string[];
}

export interface RunHooksOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface HookCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const OUTPUT_CAP = 64_000;
/** 进程被杀后 Windows 孤儿可能仍持有 stdio 管道，宽限期后强制结算 */
const SETTLE_GRACE_MS = 1_500;

function runHookCommand(
  command: string,
  stdinText: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<HookCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let grace: ReturnType<typeof setTimeout> | undefined;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      resolve({ code, stdout, stderr, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      grace = setTimeout(() => finish(-1), SETTLE_GRACE_MS);
    }, opts.timeoutMs);

    const killAndSettle = (): void => {
      timedOut = true;
      child.kill();
      grace = setTimeout(() => finish(-1), SETTLE_GRACE_MS);
    };

    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      stderr += `spawn 失败: ${err.message}`;
      finish(-1);
    });
    child.on("close", (code) => finish(code));

    if (opts.signal) {
      if (opts.signal.aborted) {
        killAndSettle();
      } else {
        opts.signal.addEventListener("abort", killAndSettle, { once: true });
      }
    }

    // 进程可能不读 stdin 就退出（EPIPE），写失败无害
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdinText);
  });
}

/** matcher 判定结果：非法正则不猜意图，跳过并上报 */
type MatcherVerdict = { match: boolean; problem?: string };

/** matcher 为正则字符串；非法正则返回 problem（由调用方记 notice 并跳过该 hook） */
function matchesMatcher(matcher: string | undefined, toolName: string): MatcherVerdict {
  if (!matcher) return { match: true };
  try {
    return { match: new RegExp(matcher).test(toolName) };
  } catch {
    return {
      match: false,
      problem: `matcher "${matcher}" 不是合法正则，已跳过该 hook`,
    };
  }
}

function pickDefs(event: HookEvent, hooks: HooksConfig): HookDef[] {
  if (event === "session_start") return hooks.sessionStart;
  if (event === "pre_tool_use") return hooks.preToolUse;
  return hooks.postToolUse;
}

function shortReason(text: string): string {
  const t = text.trim();
  return t.length > 2000 ? t.slice(0, 1997) + "..." : t;
}

/**
 * 执行一组 lifecycle hook（架构接缝：工具管道 hookPre/hookPost 的具体实现）。
 * 约定（对齐业界惯例）：
 *   - hook 进程从 stdin 收到 JSON payload（含 event/toolName/toolInput/cwd）
 *   - 退出码 0 = 放行；退出码 2 = 阻断（stderr/stdout 为原因，仅 pre_tool_use 有效）
 *   - 其他退出码 = 非致命错误 → notices，不阻断主流程
 */
export async function runHooks(
  event: HookEvent,
  hooks: HooksConfig,
  payload: Record<string, unknown>,
  opts: RunHooksOptions,
): Promise<HookOutcome> {
  const defs = pickDefs(event, hooks);
  const outcome: HookOutcome = { notices: [] };
  for (const def of defs) {
    if (event === "pre_tool_use" || event === "post_tool_use") {
      const verdict = matchesMatcher(def.matcher, String(payload.toolName ?? ""));
      if (verdict.problem) {
        outcome.notices.push(verdict.problem);
        continue;
      }
      if (!verdict.match) continue;
    }
    // cwd 统一注入 payload（hook 常需要相对当前项目执行/判断）
    const body = JSON.stringify({
      event,
      cwd: opts.cwd,
      ...payload,
      timestamp: new Date().toISOString(),
    });
    const r = await runHookCommand(def.command, body, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? hooks.timeoutMs,
      signal: opts.signal,
    });
    if (r.code === 0) continue;
    if (r.code === 2 && event === "pre_tool_use") {
      outcome.blocked = shortReason(r.stderr || r.stdout || "（hook 未输出原因）");
      return outcome;
    }
    const firstLine = (r.stderr.trim() || r.stdout.trim()).split("\n", 1)[0] ?? "";
    outcome.notices.push(
      `Hook（${event}）"${def.command}" ${r.timedOut ? "超时" : `退出码 ${r.code ?? "unknown"}`}` +
        (firstLine ? `：${shortReason(firstLine)}` : ""),
    );
  }
  return outcome;
}
