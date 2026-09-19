import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "../util/frontmatter";
import { SKILL_NAME_RE, type DiscoverOptions, type DiscoverResult } from "../skills/skills";

/**
 * 自定义斜杠命令（对齐 zcode 插件的 commands/ 目录，同时开放给用户/项目级）：
 *   <dir>/<命令名>.md
 *     ---
 *     description: 必填（命令列表展示 + 无参数调用时提示）
 *     argument-hint: <文件> [范围]   ← 可选，输入提示
 *     allowed-tools: bash, read      ← 可选（v1 登记，未接入权限引擎）
 *     model: ...                     ← 可选（v1 登记，未切换模型）
 *     ---
 *     正文即提示词模板：$ARGUMENTS = 全部参数，$1..$9 = 位置参数。
 * 命令名取自文件名；插件命令调用时带命名空间前缀：/插件名:命令名。
 */
export interface CommandDefinition {
  /** 文件名（不含 .md）；文件系统限制不含冒号 */
  name: string;
  /** 插件命令的来源插件名；用户/项目命令为 undefined */
  namespace?: string;
  /** 调用与查找用的全名：插件命令为 `插件名:命令名`，其余同 name */
  qualifiedName: string;
  description: string;
  argumentHint?: string;
  allowedTools?: string[];
  model?: string;
  /** 正文（frontmatter 之后的提示词模板） */
  body: string;
  source: "user" | "project" | "plugin";
  path: string;
}

/** 文件名约束（不含冒号——Windows 文件名限制）； qualifiedName 才允许冒号 */
const COMMAND_FILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface CommandMarkdown {
  description?: string;
  argumentHint?: string;
  allowedTools?: string;
  model?: string;
  body: string;
}

export function parseCommandMarkdown(text: string): CommandMarkdown {
  const { data, body } = parseFrontmatter(text);
  return {
    description: data.description || undefined,
    argumentHint: data["argument-hint"] || undefined,
    allowedTools: data["allowed-tools"] || undefined,
    model: data.model || undefined,
    body,
  };
}

/**
 * 命令正文 → 提示词：替换 $ARGUMENTS 与 $1..$9（缺位替换为空串）。
 * 正文没有占位符而用户给了参数时，参数追加在正文末尾（对齐业界惯例）。
 */
export function expandCommandBody(body: string, args: string): string {
  const argList = args.split(/\s+/).filter(Boolean);
  const hasPositional = /\$[1-9]/.test(body);
  const replaced = body
    .replaceAll("$ARGUMENTS", args)
    .replaceAll(/\$([1-9])/g, (_m, d: string) => argList[Number(d) - 1] ?? "");
  if (!hasPositional && !body.includes("$ARGUMENTS") && args.trim()) {
    return `${replaced}\n\n[用户参数]\n${args}`;
  }
  return replaced;
}

/** 扫描单个命令目录；插件命令带 namespace（qualifiedName = 插件名:命令名） */
export async function scanCommandDir(
  dir: string,
  source: CommandDefinition["source"],
  problems: string[],
  namespace?: string,
): Promise<CommandDefinition[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // 目录不存在是常态
  }
  const out: CommandDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const base = entry.name.replace(/\.md$/i, "");
    if (!COMMAND_FILE_RE.test(base)) {
      problems.push(
        `命令文件 ${entry.name}（${source}）名字不合法（需匹配 ${COMMAND_FILE_RE.source}），已跳过`,
      );
      continue;
    }
    const path = join(dir, entry.name);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      problems.push(`命令文件 ${entry.name}（${source}）读取失败，已跳过`);
      continue;
    }
    const parsed = parseCommandMarkdown(text);
    if (!parsed.description) {
      // description 决定命令列表的可发现性，缺失要报清楚
      problems.push(`命令 ${base}（${source}）frontmatter 缺少 description，已跳过`);
      continue;
    }
    out.push({
      name: base,
      namespace,
      qualifiedName: namespace ? `${namespace}:${base}` : base,
      description: parsed.description,
      argumentHint: parsed.argumentHint,
      allowedTools: parsed.allowedTools
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      model: parsed.model || undefined,
      body: parsed.body,
      source,
      path,
    });
  }
  return out;
}

/**
 * 自定义命令发现：用户级 ~/.wcode/commands/*.md + 项目级 <cwd>/.wcode/commands/*.md。
 * 同名时项目级覆盖用户级（与技能/子 Agent 一致的就近优先）。
 * 插件命令由 plugins/discovery 加载后经 mergeCommands 合入。
 */
export async function discoverCommands(
  opts: DiscoverOptions,
): Promise<DiscoverResult<CommandDefinition>> {
  const homeDir = opts.homeDir ?? join(homedir(), ".wcode");
  const problems: string[] = [];
  const user = await scanCommandDir(join(homeDir, "commands"), "user", problems);
  const project = await scanCommandDir(join(opts.cwd, ".wcode", "commands"), "project", problems);

  const byName = new Map<string, CommandDefinition>();
  for (const cmd of [...user, ...project]) {
    const existing = byName.get(cmd.qualifiedName);
    if (existing && existing.source === cmd.source) {
      problems.push(`命令 "${cmd.qualifiedName}"（${cmd.source}）重复定义，后发现的已覆盖`);
    }
    byName.set(cmd.qualifiedName, cmd);
  }
  return { items: [...byName.values()], problems };
}

/**
 * 把插件命令合入已发现的用户/项目命令。
 * 优先级：用户/项目 > 插件（与技能一致）；裸名冲突的插件命令只能用全名调用。
 */
export function mergeCommands(
  base: CommandDefinition[],
  pluginCommands: CommandDefinition[],
  problems: string[],
): CommandDefinition[] {
  const byName = new Map(base.map((c) => [c.qualifiedName, c]));
  for (const cmd of pluginCommands) {
    if (byName.has(cmd.qualifiedName)) {
      problems.push(
        `插件命令 "${cmd.qualifiedName}" 与既有命令重名，插件版已忽略（可用全名调用其他来源）`,
      );
      continue;
    }
    byName.set(cmd.qualifiedName, cmd);
  }
  return [...byName.values()];
}

/** 命令名查找：全名优先，裸名兜底（仅当唯一命中，歧义时返回 null 并给 problem） */
export function findCommand(
  commands: CommandDefinition[],
  name: string,
): { command?: CommandDefinition; problem?: string } {
  const lower = name.toLowerCase();
  const exact = commands.find((c) => c.qualifiedName === lower);
  if (exact) return { command: exact };
  const bare = commands.filter((c) => c.name === lower);
  if (bare.length === 1) return { command: bare[0] };
  if (bare.length > 1) {
    return {
      problem: `命令 "${lower}" 有多个来源（${bare.map((c) => c.qualifiedName).join("、")}），请用全名指定`,
    };
  }
  return {};
}

/** 名字合法性复用技能名规则（qualifiedName 的插件段用 PLUGIN_NAME_RE 校验） */
export function isValidCommandName(name: string): boolean {
  const colon = name.indexOf(":");
  if (colon === -1) return SKILL_NAME_RE.test(name);
  return SKILL_NAME_RE.test(name.slice(0, colon)) && SKILL_NAME_RE.test(name.slice(colon + 1));
}
