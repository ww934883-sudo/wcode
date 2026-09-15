import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool } from "./bash";
import { taskOutputTool, taskStopTool } from "./tasks";
import { makeToolContext, makeSession } from "../../testing/fixtures";

function ctx(dir: string) {
  return makeToolContext(makeSession(dir));
}

/** 清理临时目录：被终止进程可能短暂占住 cwd，重试并容忍失败 */
async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
    () => {},
  );
}

describe("bash 工具", () => {
  it("执行命令并返回输出与退出码", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-bash-"));
    try {
      const out = await bashTool.execute({ command: "echo hello" }, ctx(dir));
      expect(out.content).toContain("hello");
      expect(out.content).toMatch(/退出码 0/);
    } finally {
      await cleanupDir(dir);
    }
  });

  it("非零退出码可见（不算工具错误）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-bash-"));
    try {
      const out = await bashTool.execute({ command: "exit 3" }, ctx(dir));
      expect(out.content).toMatch(/退出码 3/);
    } finally {
      await cleanupDir(dir);
    }
  });

  it("cwd 生效（cat 工作目录下的 marker 文件）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-bash-"));
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(dir, "marker.txt"), "cwd-marker-42", "utf8");
      const out = await bashTool.execute({ command: "cat marker.txt" }, ctx(dir));
      expect(out.content).toContain("cwd-marker-42");
    } finally {
      await cleanupDir(dir);
    }
  });

  it("超时终止进程树", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-bash-"));
    try {
      const started = Date.now();
      const out = await bashTool.execute(
        { command: "sleep 5", timeout_ms: 400 },
        ctx(dir),
      );
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(4000);
      expect(out.content).toContain("超时");
    } finally {
      await cleanupDir(dir);
    }
  });

  it("后台任务：启动 → task_output 等待 → 拿到输出", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-bash-"));
    try {
      const context = ctx(dir);
      const start = await bashTool.execute(
        { command: "echo bg-output-42", run_in_background: true },
        context,
      );
      expect(start.content).toContain("后台任务已启动");
      const taskId = /任务 ID: (\S+)/.exec(start.content)?.[1];
      expect(taskId).toBeTruthy();
      expect(context.session.backgroundTasks.has(taskId as string)).toBe(true);

      const result = await taskOutputTool.execute(
        { task_id: taskId as string, wait_ms: 8000 },
        context,
      );
      expect(result.content).toContain("已完成");
      expect(result.content).toContain("bg-output-42");
    } finally {
      await cleanupDir(dir);
    }
  });

  it("task_stop 终止运行中的后台任务", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-bash-"));
    try {
      const context = ctx(dir);
      const start = await bashTool.execute(
        { command: "sleep 30", run_in_background: true },
        context,
      );
      const taskId = /任务 ID: (\S+)/.exec(start.content)?.[1] as string;
      const stop = await taskStopTool.execute({ task_id: taskId }, context);
      expect(stop.content).toContain("已终止");
      const after = await taskOutputTool.execute({ task_id: taskId }, context);
      expect(after.content).toContain("已完成");
    } finally {
      await cleanupDir(dir);
    }
  });

  it("task_output 未知任务 ID 给出提示", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-bash-"));
    try {
      const out = await taskOutputTool.execute({ task_id: "t-none" }, ctx(dir));
      expect(out.content).toContain("任务不存在");
    } finally {
      await cleanupDir(dir);
    }
  });
});
