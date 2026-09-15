import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineTool, type Tool } from "../tools/tool";
import type { PromptSection } from "../prompt/sections";
import { parseFrontmatter } from "../util/frontmatter";

/** 技能名约束：小写字母/数字开头，可含连字符与下划线 */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export interface SkillDefinition {
  name: string;
  description: string;
  /** SKILL.md 正文（frontmatter 之后的指令内容） */
  body: string;
  source: "user" | "project";
  path: string;
}

export interface DiscoverResult<T> {
  items: T[];
  /** 非致命问题（非法命名/读取失败等），跳过该条目并记录 */
  problems: string[];
}

export interface DiscoverOptions {
  cwd: string;
  /** 默认 ~/.wcode（测试注入） */
  homeDir?: string;
}

export interface SkillMarkdown {
  name?: string;
  description?: string;
  body: string;
}

/** SKILL.md → 元信息 + 正文（导出供测试） */
export function parseSkillMarkdown(text: string): SkillMarkdown {
  const { data, body } = parseFrontmatter(text);
  return {
    name: data.name || undefined,
    description: data.description || undefined,
    body,
  };
}

async function scanSkillDir(
  dir: string,
  source: SkillDefinition["source"],
  problems: string[],
): Promise<SkillDefinition[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // 目录不存在是常态，不算问题
  }
  const out: SkillDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name, "SKILL.md");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      problems.push(`技能目录 ${entry.name}（${source}）缺少 SKILL.md，已跳过`);
      continue;
    }
    const parsed = parseSkillMarkdown(text);
    const name = parsed.name ?? entry.name;
    if (!SKILL_NAME_RE.test(name)) {
      problems.push(`技能 "${name}"（${source}）名字不合法（需匹配 ${SKILL_NAME_RE.source}），已跳过`);
      continue;
    }
    const description =
      parsed.description ??
      parsed.body.split("\n").find((l) => l.trim())?.slice(0, 100) ??
      "";
    out.push({ name, description, body: parsed.body, source, path });
  }
  return out;
}

/**
 * 技能发现：用户级 ~/.wcode/skills/<名>/SKILL.md + 项目级 <cwd>/.wcode/skills/<名>/SKILL.md。
 * 同名时项目级覆盖用户级（就近优先）。
 */
export async function discoverSkills(
  opts: DiscoverOptions,
): Promise<DiscoverResult<SkillDefinition>> {
  const homeDir = opts.homeDir ?? join(homedir(), ".wcode");
  const problems: string[] = [];
  const user = await scanSkillDir(join(homeDir, "skills"), "user", problems);
  const project = await scanSkillDir(join(opts.cwd, ".wcode", "skills"), "project", problems);

  const byName = new Map<string, SkillDefinition>();
  for (const skill of [...user, ...project]) {
    const existing = byName.get(skill.name);
    if (existing && existing.source === skill.source) {
      problems.push(`技能名 "${skill.name}"（${skill.source}）重复定义，后发现的已覆盖`);
    }
    byName.set(skill.name, skill);
  }
  return { items: [...byName.values()], problems };
}

const SkillToolSchema = z.object({
  name: z.string().min(1).describe("要加载的技能名（见系统提示中的可用技能列表）"),
  args: z.string().optional().describe("调用技能时的附加参数（如目标文件、任务描述）"),
});

/** skill 工具：按需把 SKILL.md 正文注入上下文（渐进披露，系统提示只放清单） */
export function createSkillTool(skills: SkillDefinition[]): Tool {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const catalog = skills.map((s) => `${s.name}（${s.description}）`).join("；");
  return defineTool({
    name: "skill",
    description:
      "加载一个技能（Skill）的完整指令。当任务匹配某个技能的描述、或用户用 /技能名 调用时使用。" +
      "加载后严格按指令正文执行。可用技能: " +
      (catalog || "（当前无可用技能）"),
    schema: SkillToolSchema,
    isReadOnly: true,
    execute: async (input) => {
      const skill = byName.get(input.name);
      if (!skill) {
        return {
          content:
            `未知技能 "${input.name}"。可用技能: ` +
            (catalog || "（当前无可用技能）") +
            `。请从列表中选择，或告知用户如何创建技能（<skill-dir>/SKILL.md）。`,
        };
      }
      return {
        content:
          `已加载技能「${skill.name}」（来源: ${skill.source}）。` +
          `${input.args ? `\n用户附加参数: ${input.args}\n` : "\n"}现在严格按以下指令执行：\n\n${skill.body}`,
      };
    },
  });
}

/** 系统提示中的技能清单 section：只放名字与描述，正文由 skill 工具按需加载 */
export function createSkillsSection(skills: SkillDefinition[]): PromptSection | null {
  if (skills.length === 0) return null;
  const lines = skills
    .map((s) => `- ${s.name} — ${s.description || "（无描述）"}`)
    .join("\n");
  return {
    id: "skills",
    render: () =>
      "以下是用户可用的技能（Skills）。当任务与某个技能的描述相关时，" +
      "先用 skill 工具加载它、再按其指令继续；用户输入「/技能名」也等同于调用该技能。\n\n" +
      lines,
  };
}
