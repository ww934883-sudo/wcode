import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepTool } from "./grep";
import { makeToolContext, makeSession } from "../../testing/fixtures";

async function tmpFiles(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "wcode-grep-"));
  await writeFile(join(dir, "a.txt"), "hello world\nsecond line\n", "utf8");
  await writeFile(join(dir, "b.ts"), "const hello = 1;\n", "utf8");
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("grep 工具", () => {
  // 兼容 ripgrep 与内置降级两条实现路径：只断言结果形态，不断言实现
  it("找到匹配并输出 文件:行号: 内容", async () => {
    const t = await tmpFiles();
    try {
      const out = await grepTool.execute(
        { pattern: "hello" },
        makeToolContext(makeSession(t.dir)),
      );
      expect(out.content).toMatch(/a\.txt:1:/);
      expect(out.content).toContain("hello world");
      expect(out.content).toMatch(/b\.ts:1:/);
    } finally {
      await t.cleanup();
    }
  });

  it("include 过滤文件名", async () => {
    const t = await tmpFiles();
    try {
      const out = await grepTool.execute(
        { pattern: "hello", include: "*.txt" },
        makeToolContext(makeSession(t.dir)),
      );
      expect(out.content).toMatch(/a\.txt:1:/);
      expect(out.content).not.toMatch(/b\.ts:/);
    } finally {
      await t.cleanup();
    }
  });

  it("无匹配给出提示", async () => {
    const t = await tmpFiles();
    try {
      const out = await grepTool.execute(
        { pattern: "wxyz_not_exist" },
        makeToolContext(makeSession(t.dir)),
      );
      expect(out.content).toContain("无匹配");
    } finally {
      await t.cleanup();
    }
  });
});
