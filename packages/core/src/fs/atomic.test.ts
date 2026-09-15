import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic";

describe("writeFileAtomic", () => {
  it("写入新文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-atomic-"));
    try {
      const p = join(dir, "a.txt");
      await writeFileAtomic(p, "hello");
      expect(await readFile(p, "utf8")).toBe("hello");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("覆盖已有文件且不留临时文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-atomic-"));
    try {
      const p = join(dir, "a.txt");
      await writeFileAtomic(p, "old");
      await writeFileAtomic(p, "new");
      expect(await readFile(p, "utf8")).toBe("new");
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(dir);
      expect(files).toEqual(["a.txt"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("支持嵌套目录自动创建", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-atomic-"));
    try {
      const p = join(dir, "x", "y", "z.txt");
      await writeFileAtomic(p, "deep");
      expect(await readFile(p, "utf8")).toBe("deep");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
