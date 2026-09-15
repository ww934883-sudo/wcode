import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globTool } from "./glob";
import { makeToolContext, makeSession } from "../../testing/fixtures";
async function tmpTree(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "wcode-glob-"));
  await mkdir(join(dir, "src", "sub"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "1", "utf8");
  await writeFile(join(dir, "src", "sub", "b.ts"), "2", "utf8");
  await writeFile(join(dir, "README.md"), "3", "utf8");
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("glob 工具", () => {
  it("递归匹配并按相对路径返回", async () => {
    const t = await tmpTree();
    try {
      const out = await globTool.execute(
        { pattern: "src/**/*.ts" },
        makeToolContext(makeSession(t.dir)),
      );
      expect(out.content).toContain("共 2 个匹配");
      expect(out.content).toContain("src/a.ts");
      expect(out.content).toContain("src/sub/b.ts");
      expect(out.content).not.toContain("README.md");
    } finally {
      await t.cleanup();
    }
  });

  it("无匹配给出提示", async () => {
    const t = await tmpTree();
    try {
      const out = await globTool.execute(
        { pattern: "**/*.xyz" },
        makeToolContext(makeSession(t.dir)),
      );
      expect(out.content).toContain("无匹配文件");
    } finally {
      await t.cleanup();
    }
  });
});
