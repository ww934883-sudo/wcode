import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineTool } from "../tool";
import type { BackgroundTaskInfo, SessionState } from "../../session/state";
import { killPid, pickShell } from "./shell-utils";

const TASKS_DIR = join(homedir(), ".wcode", "tasks");
const DEFAULT_TAIL_CHARS = 4000;

/** 启动后台任务：输出重定向到文件，立即返回任务 ID（架构文档 §3 后台任务） */
export async function startBackgroundTask(
  command: string,
  cwd: string,
  registry: SessionState["backgroundTasks"],
): Promise<{ content: string }> {
  await mkdir(TASKS_DIR, { recursive: true });
  const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const outputPath = join(TASKS_DIR, `${id}.log`);

  const spec = pickShell();
  const fd = openSync(outputPath, "w");
  let child;
  try {
    child = spawn(spec.cmd, [...spec.args, command], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd); // 子进程持有已复制的句柄，父进程侧可关闭
  }

  const info: BackgroundTaskInfo = {
    id,
    command,
    pid: child.pid,
    shell: spec.name,
    outputPath,
    startedAt: Date.now(),
    done: false,
  };
  registry.set(id, info);
  child.on("close", (code) => {
    info.done = true;
    info.exitCode = code ?? -1;
  });

  return {
    content: [
      "后台任务已启动",
      `任务 ID: ${id}`,
      `命令: ${command}`,
      `输出文件: ${outputPath}`,
      "用 task_output 查看/等待输出，用 task_stop 终止。",
    ].join("\n"),
  };
}

const TaskOutputSchema = z.object({
  task_id: z.string().min(1).describe("bash run_in_background 返回的任务 ID"),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .max(60_000)
    .optional()
    .describe("最长等待毫秒数（轮询任务完成），默认 0（立即返回当前状态）"),
  tail_chars: z
    .number()
    .int()
    .positive()
    .max(50_000)
    .optional()
    .describe("返回输出末尾的字符数，默认 4000"),
});

export const taskOutputTool = defineTool({
  name: "task_output",
  description: "查看后台任务的输出与状态，可等待其完成。",
  schema: TaskOutputSchema,
  isReadOnly: true,
  rulePatterns: (input) => [`task_output(${input.task_id})`],
  execute: async (input, ctx) => {
    const info = ctx.session.backgroundTasks.get(input.task_id);
    if (!info) {
      return {
        content: `任务不存在: ${input.task_id}。可用任务: ${[...ctx.session.backgroundTasks.keys()].join(", ") || "(无)"}`,
      };
    }
    const deadline = Date.now() + (input.wait_ms ?? 0);
    while (!info.done && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    let output = "";
    try {
      const raw = await readFile(info.outputPath, "utf8");
      const tail = input.tail_chars ?? DEFAULT_TAIL_CHARS;
      output =
        raw.length > tail
          ? `...[仅显示末尾 ${tail} 字符]\n${raw.slice(-tail)}`
          : raw;
    } catch {
      output = "(尚无输出)";
    }
    const status = info.done
      ? `已完成（退出码 ${info.exitCode ?? "unknown"}）`
      : "运行中";
    return { content: `[${status}] 任务 ${info.id}: ${info.command}\n${output}` };
  },
});

const TaskStopSchema = z.object({
  task_id: z.string().min(1).describe("要终止的后台任务 ID"),
});

export const taskStopTool = defineTool({
  name: "task_stop",
  description: "终止一个后台任务（终止其整个进程树）。",
  schema: TaskStopSchema,
  isReadOnly: false,
  rulePatterns: (input) => [`task_stop(${input.task_id})`],
  execute: async (input, ctx) => {
    const info = ctx.session.backgroundTasks.get(input.task_id);
    if (!info) {
      return { content: `任务不存在: ${input.task_id}` };
    }
    if (info.done) {
      return {
        content: `任务已结束（退出码 ${info.exitCode ?? "unknown"}），无需终止。`,
      };
    }
    if (info.pid) killPid(info.pid);
    info.done = true;
    info.exitCode = -1;
    return { content: `已终止任务 ${info.id}（${info.command}）` };
  },
});
