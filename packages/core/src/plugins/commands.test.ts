import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCommandMarkdown,
  expandCommandBody,
  discoverCommands,
  mergeCommands,
  findCommand,
} from "./commands";

async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "wcode-plugin-cmds-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}) };
}

describe("expandCommandBody", () => {
  it("$ARGUMENTS 替换为全部参数", () => {
    expect(expandCommandBody("审查 $ARGUMENTS", "src/a.ts src/b.ts")).toBe("审查 src/a.ts src/b.ts");
  });

  it("$1/$2 位置参数，缺位替换为空", () => {
    expect(expandCommandBody("比较 $1 与 $2", "a.ts")).toBe("比较 a.ts 与 ");
  });

  it("无占位符时参数追加在正文末尾", () => {
    expect(expandCommandBody("直接执行", "--fast")).toBe("直接执行\n\n[用户参数]\n--fast");
  });

  it("无参数且无占位符保持原文", () => {
    expect(expandCommandBody("直接执行", "")).toBe("直接执行");
  });
});

describe("parseCommandMarkdown", () => {
  it("解析 description / argument-hint / allowed-tools", () => {
    const parsed = parseCommandMarkdown(
      ["---", "description: 代码审查", "argument-hint: <文件>", "allowed-tools: read, grep", "---", "", "审查 $1"].join("\n"),
    );
    expect(parsed.description).toBe("代码审查");
    expect(parsed.argumentHint).toBe("<文件>");
    expect(parsed.allowedTools).toBe("read, grep");
    expect(parsed.body).toBe("审查 $1");
  });
});

describe("discoverCommands", () => {
  it("扫描用户级与项目级目录，项目级覆盖同名", async () => {
    const home = await makeTempDir();
    const proj = await makeTempDir();
    try {
      await mkdir(join(home.dir, "commands"), { recursive: true });
      await mkdir(join(proj.dir, ".wcode", "commands"), { recursive: true });
      await writeFile(
        join(home.dir, "commands", "review.md"),
        "---\ndescription: 用户版\n---\n用户模板",
        "utf8",
      );
      await writeFile(
        join(proj.dir, ".wcode", "commands", "review.md"),
        "---\ndescription: 项目版\n---\n项目模板",
        "utf8",
      );
      await writeFile(
        join(proj.dir, ".wcode", "commands", "deploy.md"),
        "---\ndescription: 部署\n---\n部署 $ARGUMENTS",
        "utf8",
      );
      const res = await discoverCommands({ cwd: proj.dir, homeDir: home.dir });
      expect(res.items.map((c) => c.qualifiedName).sort()).toEqual(["deploy", "review"]);
      const review = res.items.find((c) => c.name === "review");
      expect(review?.source).toBe("project");
      expect(review?.description).toBe("项目版");
    } finally {
      await home.cleanup();
      await proj.cleanup();
    }
  });

  it("缺 description 的命令报 problem 并跳过", async () => {
    const home = await makeTempDir();
    try {
      await mkdir(join(home.dir, "commands"), { recursive: true });
      await writeFile(join(home.dir, "commands", "bad.md"), "没有 frontmatter", "utf8");
      const res = await discoverCommands({ cwd: home.dir, homeDir: home.dir });
      expect(res.items).toHaveLength(0);
      expect(res.problems.join("\n")).toContain("description");
    } finally {
      await home.cleanup();
    }
  });
});

describe("mergeCommands / findCommand", () => {
  const base = [
    { name: "review", qualifiedName: "review", description: "项目", body: "", source: "project" as const, path: "x" },
  ];

  it("插件命令与既有命令全名冲突被忽略并报 problem", () => {
    const problems: string[] = [];
    const merged = mergeCommands(
      base,
      [{ name: "review", qualifiedName: "review", description: "冲突", body: "", source: "plugin" as const, path: "y" }],
      problems,
    );
    expect(merged).toHaveLength(1);
    expect(problems.join("\n")).toContain("review");
  });

  it("findCommand：全名优先，裸名歧义报 problem", () => {
    const merged = mergeCommands(
      base,
      [{ name: "deploy", namespace: "p", qualifiedName: "p:deploy", description: "插件", body: "", source: "plugin" as const, path: "y" }],
      [],
    );
    expect(findCommand(merged, "review")?.command?.qualifiedName).toBe("review");
    expect(findCommand(merged, "p:deploy")?.command?.qualifiedName).toBe("p:deploy");
    // 裸名 review 命中多个插件命令（无全名精确匹配）时要求用全名
    const ambiguous = [
      { name: "review", namespace: "a", qualifiedName: "a:review", description: "", body: "", source: "plugin" as const, path: "y" },
      { name: "review", namespace: "b", qualifiedName: "b:review", description: "", body: "", source: "plugin" as const, path: "z" },
    ];
    expect(findCommand(ambiguous, "review")?.problem).toContain("全名");
  });
});
