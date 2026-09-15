import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTool } from "./write";
import { readTool } from "./read";
import { makeToolContext, makeSession } from "../../testing/fixtures";

describe("write 工具", () => {
  it("新建文件并原子落盘", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-write-"));
    try {
      const ctx = makeToolContext(makeSession(dir));
      const out = await writeTool.execute(
        { file_path: join(dir, "new.txt"), content: "hello\nworld\n" },
        ctx,
      );
      expect(out.content).toContain("已写入");
      expect(out.content).toContain("2 行");
      expect(await readFile(join(dir, "new.txt"), "utf8")).toBe("hello\nworld\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("覆盖未读过的已有文件被拒绝（盲写保护）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-write-"));
    try {
      const p = join(dir, "a.txt");
      await writeFile(p, "original", "utf8");
      const ctx = makeToolContext(makeSession(dir));
      const out = await writeTool.execute({ file_path: p, content: "overwritten" }, ctx);
      expect(out.content).toContain("尚未读取");
      expect(await readFile(p, "utf8")).toBe("original"); // 原文件未被破坏
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("读过之后允许覆盖，且更新已读哈希", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-write-"));
    try {
      const p = join(dir, "a.txt");
      await writeFile(p, "original", "utf8");
      const ctx = makeToolContext(makeSession(dir));
      await readTool.execute({ file_path: p }, ctx);
      const out = await writeTool.execute({ file_path: p, content: "updated" }, ctx);
      expect(out.content).toContain("已写入");
      expect(await readFile(p, "utf8")).toBe("updated");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("目标路径是目录时报错", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-write-"));
    try {
      const out = await writeTool.execute(
        { file_path: dir, content: "x" },
        makeToolContext(makeSession(dir)),
      );
      expect(out.content).toContain("目录");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
