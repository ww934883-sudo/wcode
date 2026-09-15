import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSkillTool,
  createSkillsSection,
  discoverSkills,
  parseSkillMarkdown,
  type SkillDefinition,
} from "./skills";
import { makeSession, makeToolContext } from "../testing/fixtures";

async function makeTemp(): Promise<{ base: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "wcode-skills-"));
  return { base, cleanup: () => rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {}) };
}

describe("parseSkillMarkdown", () => {
  it("解析 frontmatter 元信息与正文", () => {
    const parsed = parseSkillMarkdown(
      "---\nname: helper\ndescription: 干活用的\n---\n第一步：读文件",
    );
    expect(parsed.name).toBe("helper");
    expect(parsed.description).toBe("干活用的");
    expect(parsed.body).toBe("第一步：读文件");
  });

  it("缺 description 返回 undefined", () => {
    const parsed = parseSkillMarkdown("---\nname: bare\n---\n正文");
    expect(parsed.description).toBeUndefined();
  });
});

describe("discoverSkills", () => {
  it("用户级与项目级都被发现，同名项目级覆盖", async () => {
    const t = await makeTemp();
    try {
      const home = join(t.base, "home");
      const proj = join(t.base, "proj");
      await mkdir(join(home, "skills", "alpha"), { recursive: true });
      await mkdir(join(home, "skills", "beta"), { recursive: true });
      await mkdir(join(proj, ".wcode", "skills", "alpha"), { recursive: true });
      await writeFile(join(home, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: 用户版\n---\nA", "utf8");
      await writeFile(join(home, "skills", "beta", "SKILL.md"), "---\nname: beta\ndescription: 只在用户级\n---\nB", "utf8");
      await writeFile(join(proj, ".wcode", "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: 项目版\n---\nA2", "utf8");

      const res = await discoverSkills({ cwd: proj, homeDir: home });
      expect(res.problems).toEqual([]);
      expect(res.items).toHaveLength(2);
      const alpha = res.items.find((s) => s.name === "alpha");
      expect(alpha?.description).toBe("项目版");
      expect(alpha?.source).toBe("project");
      expect(res.items.find((s) => s.name === "beta")?.source).toBe("user");
    } finally {
      await t.cleanup();
    }
  });

  it("名字缺失回退到目录名；非法名字记录 problem 并跳过", async () => {
    const t = await makeTemp();
    try {
      const home = join(t.base, "home");
      await mkdir(join(home, "skills", "dir-name-wins"), { recursive: true });
      await mkdir(join(home, "skills", "Bad Name"), { recursive: true });
      await writeFile(join(home, "skills", "dir-name-wins", "SKILL.md"), "正文即可", "utf8");
      await writeFile(join(home, "skills", "Bad Name", "SKILL.md"), "---\nname: Bad Name\n---\nX", "utf8");

      const res = await discoverSkills({ cwd: t.base, homeDir: home });
      expect(res.items.map((s) => s.name)).toEqual(["dir-name-wins"]);
      expect(res.items[0]?.description).toBe("正文即可"); // description 缺省取正文首行
      expect(res.problems).toHaveLength(1);
      expect(res.problems[0]).toContain("名字不合法");
    } finally {
      await t.cleanup();
    }
  });

  it("目录不存在返回空且无 problem", async () => {
    const t = await makeTemp();
    try {
      const res = await discoverSkills({ cwd: t.base, homeDir: join(t.base, "nope") });
      expect(res.items).toEqual([]);
      expect(res.problems).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });
});

describe("skill 工具", () => {
  const skills: SkillDefinition[] = [
    { name: "commit", description: "提交辅助", body: "按约定写提交信息", source: "project", path: "/x" },
    { name: "review", description: "审查辅助", body: "只读检查", source: "user", path: "/y" },
  ];

  it("加载技能：正文 + 附加参数注入结果", async () => {
    const tool = createSkillTool(skills);
    const out = await tool.execute({ name: "commit", args: "范围 src/core" }, makeToolContext(makeSession("/")));
    expect(out.content).toContain("commit");
    expect(out.content).toContain("按约定写提交信息");
    expect(out.content).toContain("范围 src/core");
  });

  it("未知技能给出教学式错误并列出可用技能", async () => {
    const tool = createSkillTool(skills);
    const out = await tool.execute({ name: "nope" }, makeToolContext(makeSession("/")));
    expect(out.content).toContain('未知技能 "nope"');
    expect(out.content).toContain("commit（提交辅助）");
    expect(out.content).toContain("review（审查辅助）");
  });
});

describe("createSkillsSection", () => {
  it("空列表返回 null（不渲染）", () => {
    expect(createSkillsSection([])).toBeNull();
  });

  it("非空渲染名字与描述", () => {
    const section = createSkillsSection([
      { name: "commit", description: "提交辅助", body: "", source: "user", path: "/x" },
    ]);
    expect(section?.id).toBe("skills");
    const rendered = section?.render({ cwd: "/", platform: "win32" }) ?? "";
    expect(rendered).toContain("- commit — 提交辅助");
  });
});
