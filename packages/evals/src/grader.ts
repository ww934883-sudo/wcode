import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { EvalCheck } from "./types";

/** 逐条确定性评分：返回 null = 通过，否则给出失败原因 */
export async function gradeCheck(
  workspace: string,
  check: EvalCheck,
): Promise<string | null> {
  switch (check.type) {
    case "file_exists": {
      const text = await readText(workspace, check.path);
      return text === null ? `文件不存在: ${check.path}` : null;
    }
    case "file_absent": {
      const text = await readText(workspace, check.path);
      return text !== null ? `文件不应存在但存在: ${check.path}` : null;
    }
    case "file_contains": {
      const text = await readText(workspace, check.path);
      if (text === null) return `文件不存在: ${check.path}`;
      for (const needle of check.must_all ?? []) {
        if (!text.includes(needle)) return `${check.path} 缺少内容: ${JSON.stringify(needle)}`;
      }
      for (const needle of check.must_none ?? []) {
        if (text.includes(needle)) {
          return `${check.path} 不应包含: ${JSON.stringify(needle)}`;
        }
      }
      return null;
    }
    case "file_regex": {
      const text = await readText(workspace, check.path);
      if (text === null) return `文件不存在: ${check.path}`;
      const re = new RegExp(check.pattern, check.flags ?? "");
      if (!re.test(text)) {
        return `${check.path} 不匹配正则: /${check.pattern}/${check.flags ?? ""}`;
      }
      return null;
    }
    case "json_equals": {
      const text = await readText(workspace, check.path);
      if (text === null) return `文件不存在: ${check.path}`;
      let json: unknown;
      try {
        json = JSON.parse(text) as unknown;
      } catch (err) {
        return `${check.path} 不是合法 JSON: ${(err as Error).message}`;
      }
      const actual = walkJsonPath(json, check.field);
      if (actual.missing) return `${check.path} 缺少字段: ${check.field}`;
      if (JSON.stringify(actual.value) !== JSON.stringify(check.value)) {
        return `${check.path}.${check.field} 期望 ${JSON.stringify(check.value)}，实际 ${JSON.stringify(actual.value)}`;
      }
      return null;
    }
    case "command": {
      const res = await runCommand(check.command, workspace);
      const expectExit = check.expect_exit ?? 0;
      if (res.exitCode !== expectExit) {
        return `命令退出码 ${res.exitCode}（期望 ${expectExit}）: ${check.command}\n${res.output.slice(0, 500)}`;
      }
      if (check.output_contains && !res.output.includes(check.output_contains)) {
        return `命令输出缺少 ${JSON.stringify(check.output_contains)}: ${check.command}\n${res.output.slice(0, 500)}`;
      }
      return null;
    }
  }
}

export async function gradeAll(
  workspace: string,
  checks: EvalCheck[],
): Promise<string[]> {
  const failures: string[] = [];
  for (const check of checks) {
    const reason = await gradeCheck(workspace, check);
    if (reason) failures.push(reason);
  }
  return failures;
}

async function readText(workspace: string, rel: string): Promise<string | null> {
  try {
    return await readFile(join(workspace, rel), "utf8");
  } catch {
    return null;
  }
}

function walkJsonPath(
  value: unknown,
  field: string,
): { value: unknown; missing: boolean } {
  let current: unknown = value;
  for (const seg of field.split(".")) {
    if (current === null || typeof current !== "object") {
      return { value: undefined, missing: true };
    }
    const next = (current as Record<string, unknown>)[seg];
    if (next === undefined) return { value: undefined, missing: true };
    current = next;
  }
  return { value: current, missing: false };
}

function runCommand(
  command: string,
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (c: Buffer) => (output += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (output += c.toString("utf8")));
    const timer = setTimeout(() => kill(child), 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, output });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ exitCode: -1, output: "spawn failed" });
    });
  });
}

function kill(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (pid) {
    if (process.platform === "win32") {
      spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  } else {
    child.kill("SIGKILL");
  }
}
