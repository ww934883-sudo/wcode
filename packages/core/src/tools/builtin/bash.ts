import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import { defineTool } from "../tool";
import {
  DEFAULT_BASH_TIMEOUT_MS,
  cappedStream,
  killTree,
  pickShell,
  powershellSpec,
} from "./shell-utils";
import { startBackgroundTask } from "./tasks";

const BashSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe("要执行的命令（bash 语法；每次调用独立进程，不保留 cd 等状态）"),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe("超时毫秒数（超时将终止整个进程树），默认 120000"),
  run_in_background: z
    .boolean()
    .optional()
    .describe("为 true 时立即返回任务 ID，输出写入文件；用 task_output 查看、task_stop 终止"),
});

export const bashTool = defineTool({
  name: "bash",
  description:
    "在 shell 中执行命令（构建、测试、git 等）。每次调用独立进程，不保留工作目录等状态；" +
    "需要 cd 请在命令内联。输出含 stdout/stderr 与退出码。长命令（dev server、长测试）" +
    "设置 run_in_background=true，用 task_output / task_stop 管理。",
  schema: BashSchema,
  isReadOnly: false,
  rulePatterns: (input) => [`bash(${input.command})`],
  execute: async (input, ctx) => {
    const cwd = ctx.session.cwd;
    const timeoutMs = input.timeout_ms ?? ctx.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
    if (input.run_in_background) {
      return startBackgroundTask(input.command, cwd, ctx.session.backgroundTasks);
    }
    return runForeground(input.command, cwd, timeoutMs, ctx.signal);
  },
});

async function runForeground(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ content: string }> {
  let spec = pickShell();
  let child: ChildProcess;
  try {
    child = spawn(spec.cmd, [...spec.args, command], {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && process.platform === "win32") {
      spec = powershellSpec();
      child = spawn(spec.cmd, [...spec.args, command], {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      throw err;
    }
  }

  const stdout = { text: "" };
  const stderr = { text: "" };
  cappedStream(child.stdout, stdout);
  cappedStream(child.stderr, stderr);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, timeoutMs);
  const onAbort = () => killTree(child);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  const exitCode = await new Promise<number>((resolve2) => {
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve2(code ?? -1);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      // bash 不在 PATH（Windows）：换 PowerShell 重试一次
      if (
        (err as NodeJS.ErrnoException).code === "ENOENT" &&
        process.platform === "win32" &&
        spec.name === "bash"
      ) {
        spec = powershellSpec();
        const retry = spawn(spec.cmd, [...spec.args, command], {
          cwd,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const retryOut = { text: "" };
        const retryErr = { text: "" };
        cappedStream(retry.stdout, retryOut);
        cappedStream(retry.stderr, retryErr);
        retry.on("close", (code) => {
          stdout.text = retryOut.text;
          stderr.text = retryErr.text;
          resolve2(code ?? -1);
        });
        retry.on("error", () => resolve2(-1));
        return;
      }
      stderr.text += `\n[spawn error] ${String(err)}`;
      resolve2(-1);
    });
  });

  const merged =
    stdout.text + (stderr.text ? `\n[stderr]\n${stderr.text}` : "");
  const tail = timedOut
    ? `[命令超时（>${timeoutMs}ms），进程树已终止]`
    : `[退出码 ${exitCode}，shell: ${spec.name}]`;
  return { content: `${merged}\n${tail}` };
}
