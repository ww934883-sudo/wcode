import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editTool } from "./edit";
import { readTool } from "./read";
import { makeToolContext, makeSession } from "../../testing/fixtures";

async function setup(content: string): Promise<{ dir: string; path: string; ctx: ReturnType<typeof makeToolContext> }> {
  const dir = await mkdtemp(join(tmpdir(), "wcode-edit-"));
  const path = join(dir, "a.txt");
  await writeFile(path, content, "utf8");
  const session = makeSession(dir);
  const ctx = makeToolContext(session);
  await readTool.execute({ file_path: path }, ctx); // 编辑前必须已读
  return { dir, path, ctx };
}

describe("edit 工具", () => {
  it("唯一匹配替换成功并更新已读哈希", async () => {
    const t = await setup("alpha\nbeta\ngamma\n");
    try {
      const out = await editTool.execute(
        { file_path: t.path, old_string: "beta", new_string: "BETA" },
        t.ctx,
      );
      expect(out.content).toContain("已编辑");
      expect(out.content).toContain("替换 1 处");
      expect(await readFile(t.path, "utf8")).toBe("alpha\nBETA\ngamma\n");
      // 更新哈希后可以继续编辑（不会误判过期）
      const out2 = await editTool.execute(
        { file_path: t.path, old_string: "BETA", new_string: "b" },
        t.ctx,
      );
      expect(out2.content).toContain("已编辑");
    } finally {
      await rm(t.dir, { recursive: true, force: true });
    }
  });

  it("未找到匹配给出教学式报错", async () => {
    const t = await setup("alpha\nbeta\n");
    try {
      const out = await editTool.execute(
        { file_path: t.path, old_string: "BETA ", new_string: "x" },
        t.ctx,
      );
      expect(out.content).toContain("未找到");
    } finally {
      await rm(t.dir, { recursive: true, force: true });
    }
  });

  it("多处匹配且未开 replace_all 时拒绝", async () => {
    const t = await setup("x\nx\nx\n");
    try {
      const out = await editTool.execute(
        { file_path: t.path, old_string: "x", new_string: "y" },
        t.ctx,
      );
      expect(out.content).toContain("3 处");
      expect(await readFile(t.path, "utf8")).toBe("x\nx\nx\n"); // 未被改动
    } finally {
      await rm(t.dir, { recursive: true, force: true });
    }
  });

  it("replace_all 全部替换", async () => {
    const t = await setup("x\nx\nx\n");
    try {
      const out = await editTool.execute(
        { file_path: t.path, old_string: "x", new_string: "y", replace_all: true },
        t.ctx,
      );
      expect(out.content).toContain("替换 3 处");
      expect(await readFile(t.path, "utf8")).toBe("y\ny\ny\n");
    } finally {
      await rm(t.dir, { recursive: true, force: true });
    }
  });

  it("读取后被外部修改 → 拒绝编辑（过期保护）", async () => {
    const t = await setup("original\n");
    try {
      await writeFile(t.path, "tampered\n", "utf8"); // 模拟外部修改
      const out = await editTool.execute(
        { file_path: t.path, old_string: "tampered", new_string: "y" },
        t.ctx,
      );
      expect(out.content).toContain("外部修改");
      expect(await readFile(t.path, "utf8")).toBe("tampered\n");
    } finally {
      await rm(t.dir, { recursive: true, force: true });
    }
  });

  it("未读过直接编辑被拒绝", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-edit-"));
    try {
      const path = join(dir, "b.txt");
      await writeFile(path, "abc\n", "utf8");
      const ctx = makeToolContext(makeSession(dir));
      const out = await editTool.execute(
        { file_path: path, old_string: "abc", new_string: "x" },
        ctx,
      );
      expect(out.content).toContain("尚未读取");
      expect(await readFile(path, "utf8")).toBe("abc\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
