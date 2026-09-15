import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTool } from "./read";
import { makeToolContext, makeSession } from "../../testing/fixtures";

async function tmpWithFile(content: string, name = "a.txt"): Promise<{ dir: string; path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "wcode-read-"));
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  return { dir, path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("read 工具", () => {
  it("输出带行号", async () => {
    const t = await tmpWithFile("alpha\nbeta\ngamma\n");
    try {
      const out = await readTool.execute({ file_path: t.path }, makeToolContext(makeSession(t.dir)));
      expect(out.content).toContain("1\talpha");
      expect(out.content).toContain("3\tgamma");
    } finally {
      await t.cleanup();
    }
  });

  it("offset/limit 分页", async () => {
    const t = await tmpWithFile("l1\nl2\nl3\nl4\nl5\n");
    try {
      const out = await readTool.execute(
        { file_path: t.path, offset: 2, limit: 2 },
        makeToolContext(makeSession(t.dir)),
      );
      expect(out.content).toContain("2\tl2");
      expect(out.content).toContain("3\tl3");
      expect(out.content).not.toContain("4\tl4");
      expect(out.content).toContain("继续读取");
    } finally {
      await t.cleanup();
    }
  });

  it("文件不存在给出友好报错", async () => {
    const t = await tmpWithFile("x");
    try {
      const out = await readTool.execute(
        { file_path: join(t.dir, "missing.txt") },
        makeToolContext(makeSession(t.dir)),
      );
      expect(out.content).toContain("文件不存在");
    } finally {
      await t.cleanup();
    }
  });

  it("空文件", async () => {
    const t = await tmpWithFile("");
    try {
      const out = await readTool.execute({ file_path: t.path }, makeToolContext(makeSession(t.dir)));
      expect(out.content).toBe("(空文件)");
    } finally {
      await t.cleanup();
    }
  });

  it("超过 2000 行截断并提示继续", async () => {
    const lines = Array.from({ length: 2100 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
    const t = await tmpWithFile(lines);
    try {
      const out = await readTool.execute({ file_path: t.path }, makeToolContext(makeSession(t.dir)));
      expect(out.content).toContain("1\tline-1");
      expect(out.content).not.toContain("2100\tline-2100");
      expect(out.content).toContain("文件共 2100 行");
    } finally {
      await t.cleanup();
    }
  });

  it("读取后记录到 filesRead（write 的盲写保护依据）", async () => {
    const t = await tmpWithFile("content\n");
    try {
      const session = makeSession(t.dir);
      await readTool.execute({ file_path: t.path }, makeToolContext(session));
      expect(session.filesRead.size).toBe(1);
    } finally {
      await t.cleanup();
    }
  });
});
