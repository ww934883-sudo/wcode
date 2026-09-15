import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents, parseAgentMarkdown } from "./defs";

async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "wcode-agents-"));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {}),
  };
}

describe("parseAgentMarkdown", () => {
  it("解析 name/description/tools 与正文", () => {
    const parsed = parseAgentMarkdown(
      "---\nname: reviewer\ndescription: 只读审查\ntools: read, glob, grep\n---\n你是审查员",
    );
    expect(parsed.name).toBe("reviewer");
    expect(parsed.description).toBe("只读审查");
    expect(parsed.tools).toBe("read, glob, grep");
    expect(parsed.body).toBe("你是审查员");
  });

  it("无 frontmatter 时正文为全文", () => {
    const parsed = parseAgentMarkdown("直接正文");
    expect(parsed.name).toBeUndefined();
    expect(parsed.body).toBe("直接正文");
  });
});

describe("discoverAgents", () => {
  it("发现两级定义并解析 tools 字段（列表/all/缺省）", async () => {
    const t = await makeTempDir();
    try {
      const home = join(t.dir, "home");
      const proj = join(t.dir, "proj");
      await mkdir(join(home, "agents"), { recursive: true });
      await mkdir(join(proj, ".wcode", "agents"), { recursive: true });
      await writeFile(
        join(home, "agents", "explorer.md"),
        "---\nname: explorer\ndescription: 只读探索\n---\n去找文件",
        "utf8",
      );
      await writeFile(
        join(proj, ".wcode", "agents", "tester.md"),
        "---\nname: tester\ndescription: 跑测试\ntools: all\n---\n负责验证",
        "utf8",
      );
      await writeFile(
        join(proj, ".wcode", "agents", "reviewer.md"),
        "---\ntools: read, grep\n---\n审查正文",
        "utf8",
      );

      const res = await discoverAgents({ cwd: proj, homeDir: home });
      expect(res.problems).toEqual([]);
      const byName = new Map(res.items.map((a) => [a.name, a]));
      expect(byName.get("explorer")?.tools).toBe("readonly"); // 缺省
      expect(byName.get("tester")?.tools).toBe("all");
      // 名字缺省取文件名 reviewer.md → reviewer
      const reviewer = byName.get("reviewer");
      expect(reviewer?.tools).toEqual(["read", "grep"]);
      expect(reviewer?.source).toBe("project");
      expect(res.items).toHaveLength(3);
    } finally {
      await t.cleanup();
    }
  });

  it("同名项目级覆盖用户级；非法名字跳过并记录", async () => {
    const t = await makeTempDir();
    try {
      const home = join(t.dir, "home");
      const proj = join(t.dir, "proj");
      await mkdir(join(home, "agents"), { recursive: true });
      await mkdir(join(proj, ".wcode", "agents"), { recursive: true });
      await writeFile(join(home, "agents", "dup.md"), "---\ndescription: 用户版\n---\nU", "utf8");
      await writeFile(join(proj, ".wcode", "agents", "dup.md"), "---\ndescription: 项目版\n---\nP", "utf8");
      await writeFile(join(proj, ".wcode", "agents", "Bad Name.md"), "---\nname: Bad Name\n---\nX", "utf8");

      const res = await discoverAgents({ cwd: proj, homeDir: home });
      const dup = res.items.find((a) => a.name === "dup");
      expect(dup?.description).toBe("项目版");
      expect(res.items).toHaveLength(1);
      expect(res.problems).toHaveLength(1);
      expect(res.problems[0]).toContain("名字不合法");
    } finally {
      await t.cleanup();
    }
  });
});
