import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider, endTurn, toolUseTurn, type FakeTurn } from "@wcode/core/testing";
import { runHeadless } from "./headless";

async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "wcode-headless-"));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {}),
  };
}

function captureStderr() {
  const lines: string[] = [];
  return { lines, write: (l: string) => lines.push(l) };
}

async function headless(
  turns: FakeTurn[],
  opts?: { outputFormat?: "text" | "json"; prompt?: string },
) {
  const t = await makeTempDir();
  const stderr = captureStderr();
  try {
    const provider = new FakeProvider(turns);
    const result = await runHeadless({
      prompt: opts?.prompt ?? "自动化任务",
      outputFormat: opts?.outputFormat,
      provider,
      cwd: t.dir,
      writeStderr: stderr.write,
    });
    return { ...result, stderr: stderr.lines };
  } finally {
    await t.cleanup();
  }
}

describe("runHeadless（无头自动化模式）", () => {
  it("text 模式：执行任务并输出最终回复，退出码 0", async () => {
    const r = await headless([{ response: endTurn("自动化完成：已检查 3 个文件") }]);
    expect(r.code).toBe(0);
    expect(r.status).toBe("end_turn");
    expect(r.stdout).toBe("自动化完成：已检查 3 个文件");
  });

  it("工具进度行写入 stderr（含失败标记）", async () => {
    const t = await makeTempDir();
    try {
      const target = join(t.dir, "note.txt");
      await writeFile(target, "headless marker", "utf8");
      const provider = new FakeProvider([
        { response: toolUseTurn([{ id: "t1", name: "read", input: { file_path: target } }]) },
        { response: toolUseTurn([{ id: "t2", name: "read", input: { file_path: join(t.dir, "missing.txt") } }]) },
        { response: endTurn("读完了，缺失文件已汇报") },
      ]);
      const stderr: string[] = [];
      const result = await runHeadless({
        prompt: "读文件",
        provider,
        cwd: t.dir,
        writeStderr: (l) => stderr.push(l),
      });
      expect(result.code).toBe(0);
      const toolLines = stderr.filter((l) => l.startsWith("⏺ read"));
      expect(toolLines).toHaveLength(2);
      // read 对缺失文件返回「教学式」内容（不抛错），进度行展示摘要
      expect(toolLines[0]).toContain("headless marker");
      expect(toolLines[1]).toContain("文件不存在");
    } finally {
      await t.cleanup();
    }
  });

  it("权限询问自动拒绝（stderr 可见，模型收到拒绝结果继续收尾）", async () => {
    const r = await headless([
      { response: toolUseTurn([{ id: "t1", name: "write", input: { file_path: "out.txt", content: "x" } }]) },
      { response: endTurn("写入被拒，改为汇报方案") },
    ]);
    expect(r.stderr.some((l) => l.includes("无头模式自动拒绝") && l.includes("write"))).toBe(true);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("写入被拒");
  });

  it("json 模式输出 status/reply/usage/model", async () => {
    const r = await headless([{ response: endTurn("JSON 回复") }], { outputFormat: "json" });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      status: string;
      reply: string;
      usage: { inputTokens: number; outputTokens: number };
      model: string;
    };
    expect(parsed.status).toBe("end_turn");
    expect(parsed.reply).toBe("JSON 回复");
    expect(parsed.usage.inputTokens).toBeGreaterThan(0);
    expect(typeof parsed.model).toBe("string");
  });

  it("模型运行错误 → 退出码 1 且 stderr 报错", async () => {
    const r = await headless([]); // 脚本耗尽 → ProviderError
    expect(r.code).toBe(1);
    expect(r.stderr.some((l) => l.startsWith("出错:"))).toBe(true);
  });
});
