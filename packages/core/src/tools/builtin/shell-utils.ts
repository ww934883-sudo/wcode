import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_STREAM_CHARS = 1_000_000;

export interface ShellSpec {
  cmd: string;
  args: string[];
  name: string;
}

/**
 * 在 PATH 各目录里找可执行文件（Windows 按名字+.exe 精确匹配）。
 * 裸名 spawn 依赖 CreateProcess 的 PATH 解析，GUI 启动的进程（Electron）PATH
 * 常缺 Git/bash 条目，且解析失败的错误难诊断——这里显式解析为绝对路径。
 */
export function findOnPath(name: string): string | null {
  const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  const names = process.platform === "win32" ? [name, `${name}.exe`] : [name];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const n of names) {
      const candidate = join(dir.trim(), n);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Windows 上 PowerShell 的绝对路径：System32 自带 5.1，优先新装 的 pwsh 7+ */
function findPowerShell(): string {
  const candidates = [
    join(process.env["ProgramFiles"] ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
    join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "powershell"; // 兜底裸名（保持旧行为，ENOENT 由调用方报清楚）
}

/**
 * shell 选择（架构文档 §3）：POSIX 与 Windows 都优先 bash。
 * Windows 上按 PATH 显式解析 bash.exe（Git\bin / Git\usr\bin）；
 * 找不到（GUI 环境常见）直接用 PowerShell 绝对路径，而不是裸名 spawn 赌 PATH。
 * 结果按进程生命周期缓存（PATH 运行期不变，省去每次 existsSync 扫描）。
 */
let cachedSpec: ShellSpec | null = null;

export function pickShell(): ShellSpec {
  if (cachedSpec) return cachedSpec;
  let spec: ShellSpec;
  if (process.platform === "win32") {
    const bash = findOnPath("bash");
    spec = bash
      ? { cmd: bash, args: ["-c"], name: "bash" }
      : { cmd: findPowerShell(), args: ["-NoProfile", "-Command"], name: "powershell" };
  } else {
    spec = { cmd: "bash", args: ["-c"], name: "bash" };
  }
  cachedSpec = spec;
  return spec;
}

export function powershellSpec(): ShellSpec {
  return { cmd: findPowerShell(), args: ["-NoProfile", "-Command"], name: "powershell" };
}

/** 测试注入用：清空 pickShell 的进程级缓存 */
export function resetShellCacheForTest(): void {
  cachedSpec = null;
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
