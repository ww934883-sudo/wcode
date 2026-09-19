import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "../util/frontmatter";
import { SKILL_NAME_RE } from "../skills/skills";
import type { DiscoverOptions, DiscoverResult } from "../skills/skills";

/**
 * 自定义子 Agent 定义（M2）：<dir>/<name>.md
 *   ---
 *   name: reviewer
 *   description: 只读代码审查
 *   tools: read, glob, grep   ← 省略=readonly；all=全部（除 task）
 *   ---
 *   正文 = 子 Agent 的 system prompt
 */
export interface CustomAgentDef {
  name: string;
  description: string;
  /** "all" | "readonly" | 工具名列表 */
  tools: "all" | "readonly" | string[];
  body: string;
  /** plugin 来源的名称带命名空间（插件名:Agent名） */
  source: "user" | "project" | "plugin";
  path: string;
}

export interface AgentMarkdown {
  name?: string;
  description?: string;
  tools?: string;
  body: string;
}

export function parseToolsField(raw: string | undefined): CustomAgentDef["tools"] {
  const v = raw?.trim();
  if (!v) return "readonly";
  if (v === "all" || v === "readonly") return v;
  const names = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length > 0 ? names : "readonly";
}

export function parseAgentMarkdown(text: string): AgentMarkdown {
  const { data, body } = parseFrontmatter(text);
  return {
    name: data.name || undefined,
    description: data.description || undefined,
    tools: data.tools || undefined,
    body,
  };
}

async function scanAgentDir(
  dir: string,
  source: CustomAgentDef["source"],
  problems: string[],
): Promise<CustomAgentDef[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // 目录不存在是常态
  }
  const out: CustomAgentDef[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = join(dir, entry.name);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      problems.push(`子 Agent 定义 ${entry.name}（${source}）读取失败，已跳过`);
      void err;
      continue;
    }
    const parsed = parseAgentMarkdown(text);
    const name = parsed.name ?? entry.name.replace(/\.md$/i, "");
    if (!SKILL_NAME_RE.test(name)) {
      problems.push(`子 Agent "${name}"（${source}）名字不合法（需匹配 ${SKILL_NAME_RE.source}），已跳过`);
      continue;
    }
    const description =
      parsed.description ??
      parsed.body.split("\n").find((l) => l.trim())?.slice(0, 100) ??
      "";
    out.push({
      name,
      description,
      tools: parseToolsField(parsed.tools),
      body: parsed.body,
      source,
      path,
    });
  }
  return out;
}

/** 子 Agent 发现：~/.wcode/agents/*.md + <cwd>/.wcode/agents/*.md，同名项目级覆盖 */
export async function discoverAgents(
  opts: DiscoverOptions,
): Promise<DiscoverResult<CustomAgentDef>> {
  const homeDir = opts.homeDir ?? join(homedir(), ".wcode");
  const problems: string[] = [];
  const user = await scanAgentDir(join(homeDir, "agents"), "user", problems);
  const project = await scanAgentDir(join(opts.cwd, ".wcode", "agents"), "project", problems);

  const byName = new Map<string, CustomAgentDef>();
  for (const agent of [...user, ...project]) {
    const existing = byName.get(agent.name);
    if (existing && existing.source === agent.source) {
      problems.push(`子 Agent "${agent.name}"（${agent.source}）重复定义，后发现的已覆盖`);
    }
    byName.set(agent.name, agent);
  }
  return { items: [...byName.values()], problems };
}
