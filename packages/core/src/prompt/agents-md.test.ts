import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentsMdSection, loadAgentsMdFiles } from "./agents-md";

describe("loadAgentsMdFiles", () => {
  it("全局 → 项目 AGENTS.md → CLAUDE.md 依序拼接", async () => {
    const base = await mkdtemp(join(tmpdir(), "wcode-agents-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      const homeDir = join(base, "home");
      const cwd = join(base, "proj");
      await mkdir(homeDir, { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeFile(join(homeDir, "AGENTS.md"), "GLOBAL RULE", "utf8");
      await writeFile(join(cwd, "AGENTS.md"), "PROJECT RULE", "utf8");
      await writeFile(join(cwd, "CLAUDE.md"), "LEGACY RULE", "utf8");

      const merged = await loadAgentsMdFiles({ cwd, homeDir });
      expect(merged).toBe("GLOBAL RULE\n\nPROJECT RULE\n\nLEGACY RULE");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("全部缺失返回空串", async () => {
    const base = await mkdtemp(join(tmpdir(), "wcode-agents-"));
    try {
      const merged = await loadAgentsMdFiles({ cwd: base, homeDir: join(base, "none") });
      expect(merged).toBe("");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("createAgentsMdSection", () => {
  it("空内容返回 null（不渲染）", () => {
    expect(createAgentsMdSection("")).toBeNull();
    expect(createAgentsMdSection("  \n")).toBeNull();
  });

  it("有内容生成 section 且包含原文", () => {
    const s = createAgentsMdSection("始终使用中文注释");
    expect(s?.id).toBe("agents-md");
    expect(s?.render({ cwd: "/x", platform: "win32" })).toContain("始终使用中文注释");
  });
});
