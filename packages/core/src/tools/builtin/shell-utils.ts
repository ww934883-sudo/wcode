import { spawn, type ChildProcess } from "node:child_process";

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_STREAM_CHARS = 1_000_000;

export interface ShellSpec {
  cmd: string;
  args: string[];
  name: string;
}

/**
 * shell 选择（架构文档 §3）：POSIX 与 Windows 都优先 bash -c
 * （GitHub Windows runner 与 Git Bash 环境都有 bash），ENONENT 时由调用方降级 PowerShell。
 */
export function pickShell(): ShellSpec {
  return { cmd: "bash", args: ["-c"], name: "bash" };
}

export function powershellSpec(): ShellSpec {
  return { cmd: "powershell", args: ["-NoProfile", "-Command"], name: "powershell" };
}

/** 进程树清理：Windows taskkill /T /F；POSIX 杀进程组（spawn 时 detached） */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    child.kill("SIGKILL");
    return;
  }
  killPid(pid);
}

/** 按 PID 终止整个进程树（供后台任务 task_stop 复用） */
export function killPid(pid: number): void {
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => {
      try {
        process.kill(pid);
      } catch {
        /* 进程已退出 */
      }
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL"); // detached 进程组
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 进程已退出 */
      }
    }
  }
}

export function cappedStream(
  stream: NodeJS.ReadableStream | null,
  sink: { text: string },
): void {
  stream?.on("data", (chunk: Buffer) => {
    if (sink.text.length < MAX_STREAM_CHARS) {
      sink.text += chunk.toString("utf8");
    }
  });
}
