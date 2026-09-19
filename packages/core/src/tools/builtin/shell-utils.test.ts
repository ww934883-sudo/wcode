import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BASH_TIMEOUT_MS, findOnPath, pickShell, powershellSpec, resetShellCacheForTest } from "./shell-utils";
import { runForeground } from "./bash";

/** GUI 环境（Electron）PATH 复刻：有 System32 的 PowerShell、无 bash.exe */
let savedPath: string | undefined;
let savedRoot: string | undefined;

beforeEach(() => {
  savedPath = process.env.PATH;
  savedRoot = process.env.SystemRoot;
  resetShellCacheForTest();
});
afterEach(() => {
  process.env.PATH = savedPath;
  if (savedRoot !== undefined) process.env.SystemRoot = savedRoot;
  resetShellCacheForTest();
});

describe("findOnPath / pickShell", () => {
  it("在 PATH 目录中解析出可执行文件（含 .exe 补全）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-shell-"));
    try {
      await writeFile(join(dir, "fakebash.exe"), "");
      process.env.PATH = dir;
      expect(findOnPath("fakebash")).toBe(join(dir, "fakebash.exe"));
      expect(findOnPath("definitely-not-here-xyz")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("win32 无 bash 时 pickShell 直接返回 PowerShell 绝对路径（不再裸名赌 PATH）", () => {
    if (process.platform !== "win32") return;
    process.env.PATH = "C:\\definitely-not-a-dir";
    const spec = pickShell();
    expect(spec.name).toBe("powershell");
    expect(spec.cmd).toMatch(/powershell\.exe$|pwsh\.exe$/i);
    expect(spec.cmd).toContain("\\");
  });
});

describe("runForeground shell 降级竞态", () => {
  it("bash 启动失败（ENOENT）时 PowerShell 重试的输出不被丢弃", async () => {
    if (process.platform !== "win32") return;
    // 故意给一个不存在的 bash：走 ENOENT → powershellSpec（绝对路径，可用）
    const res = await runForeground("echo ok", process.cwd(), DEFAULT_BASH_TIMEOUT_MS, new AbortController().signal, {
      cmd: "wcode-no-such-shell-xyz",
      args: ["-c"],
      name: "bash",
    });
    expect(res.content).toContain("ok");
    expect(res.content).toContain("shell: powershell");
    expect(res.content).not.toContain("-4058");
  });

  it("bash 与 PowerShell 都不可用时给出可行动错误（不再静默 -1 无输出）", async () => {
    if (process.platform !== "win32") return;
    // 污染 PATH 与 PowerShell 探测根目录：两级 shell 都解析到不存在的可执行文件
    process.env.PATH = "C:\\definitely-not-a-dir";
    process.env.SystemRoot = "C:\\definitely-not-a-dir";
    process.env.ProgramFiles = "C:\\definitely-not-a-dir";
    const res = await runForeground("echo ok", process.cwd(), DEFAULT_BASH_TIMEOUT_MS, new AbortController().signal, {
      cmd: "wcode-no-such-bash-xyz",
      args: ["-c"],
      name: "bash",
    });
    expect(res.content).toContain("shell 启动失败");
    expect(res.content).toContain("PATH");
  }, 10_000);

  it("powershellSpec 指向存在的可执行文件", () => {
    if (process.platform !== "win32") return;
    const spec = powershellSpec();
    expect(spec.name).toBe("powershell");
  });
});
