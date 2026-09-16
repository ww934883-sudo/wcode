import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { errorMessage } from "@wcode/core";
import type { AutomationOutcome, AutomationRecord } from "@wcode/core";

/** 一次自动化派发的结果（映射 headless JSON 的 status / 退出码） */
export interface AutomationDispatchResult {
  outcome: AutomationOutcome;
  exitCode: number;
  sessionId?: string;
  reply?: string;
  error?: string;
}

export type AutomationRunner = (
  automation: AutomationRecord,
) => Promise<AutomationDispatchResult>;

/** cli/src/bin.tsx 的绝对路径（runner.ts 在 cli/src/automation/ 下） */
export function cliEntryPath(): string {
  return fileURLToPath(new URL("../bin.tsx", import.meta.url));
}

/**
 * 默认派发器：spawn `wcode -p --output-format=json` 子进程（与当前进程同 loader，
 * tsx 的 execArgv 会带入）——daemon 逻辑与执行完全解耦，测试可注入假 runner。
 * 无人值守权限由 --mode 控制（默认 default=自动拒绝变更任务）。
 */
export function createDefaultRunner(
  opts: { write?: (line: string) => void } = {},
): AutomationRunner {
  const write = opts.write ?? (() => {});
  return (automation) =>
    new Promise<AutomationDispatchResult>((resolve) => {
      const args = [
        ...process.execArgv,
        "--disable-warning=ExperimentalWarning",
        cliEntryPath(),
        "-p",
        "--output-format=json",
      ];
      if (automation.mode && automation.mode !== "default") {
        args.push(`--mode=${automation.mode}`);
      }
      if (automation.model) args.push(`--model=${automation.model}`);
      if (automation.provider) args.push(`--provider=${automation.provider}`);
      args.push(automation.prompt);

      const child = spawn(process.execPath, args, {
        cwd: automation.cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      if (automation.timeoutMs && automation.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          write(`[runner] 超时（${automation.timeoutMs}ms），终止子进程: ${automation.title}`);
          child.kill();
        }, automation.timeoutMs);
      }

      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        resolve({
          outcome: "failed",
          exitCode: -1,
          error: `子进程启动失败: ${errorMessage(err)}`,
        });
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        if (timedOut) {
          resolve({ outcome: "timeout", exitCode: code ?? -1, error: "执行超时被终止" });
          return;
        }
        if (code === 0) {
          try {
            const parsed = JSON.parse(stdout) as {
              status?: string;
              reply?: string;
              sessionId?: string;
            };
            resolve({
              outcome: parsed.status === "max_turns" ? "max_turns" : "success",
              exitCode: 0,
              sessionId: parsed.sessionId,
              reply: parsed.reply,
              error: parsed.status === "max_turns" ? "已达单任务最大轮数" : undefined,
            });
          } catch {
            resolve({ outcome: "failed", exitCode: 0, error: "子进程输出不是合法 JSON" });
          }
          return;
        }
        resolve({
          outcome: "failed",
          exitCode: code ?? -1,
          error: stderr.trim().split("\n").slice(-3).join("；") || `退出码 ${code}`,
        });
      });
    });
}
