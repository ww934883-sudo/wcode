import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  discoverSkills,
  parseSkillMarkdown,
  SKILL_NAME_RE,
  type SkillDefinition,
} from "../skills/skills";
import { discoverAgents, parseAgentMarkdown, parseToolsField, type CustomAgentDef } from "../agents/defs";
import { discoverCommands, scanCommandDir, type CommandDefinition } from "./commands";
import {
  findPluginManifest,
  componentPathsToList,
  type PluginManifestInfo,
} from "./manifest";
import { parseHooksFile } from "./hooks-file";
import { readSeed, compareVersions } from "./install";
import { defaultPluginsDir } from "./marketplace";
import { mcpServerSpecSchema, type HooksConfig } from "../config/schema";
import type { McpServerConfig } from "../mcp/tool-source";
import { errorMessage } from "../errors";

/**
 * 插件发现与扩展装配（工具接缝 / 系统提示的统一入口）：
 *   - 已安装插件 = ~/.wcode/plugins/cache/<市场>/<插件>/<版本>/（对齐 zcode 布局）
 *   - 组件命名空间化：技能/子 Agent/命令 → `插件名:名字`；MCP → `plugin:<插件名>:<服务名>`
 *   - 用户/项目级同名组件优先于插件（就近原则与技能一致）
 */

/** hooks 七事件在 HooksConfig 里的键（合并插件 hooks.json 时逐事件拼接） */
const HOOK_EVENT_KEYS = [
  "sessionStart",
  "userPromptSubmit",
  "preToolUse",
  "permissionRequest",
  "postToolUse",
  "postToolUseFailure",
  "stop",
] as const;

export interface DiscoveredPlugin {
  name: string;
  version: string;
  description?: string;
  marketplace: string;
  /** config.plugins.enabled 的启停标记（缺省启用） */
  enabled: boolean;
  /** 插件根目录（cache 内的版本目录） */
  root: string;
  manifestPath: string;
  format: "zcode" | "claude";
  /** 命名空间化后的组件（禁用时为空） */
  skills: SkillDefinition[];
  agents: CustomAgentDef[];
  commands: CommandDefinition[];
  /** 键 = plugin:<插件名>:<服务名>（变量已替换） */
  mcpServers: Record<string, McpServerConfig>;
  hooks: Partial<Omit<HooksConfig, "timeoutMs">>;
  problems: string[];
}

export interface ExtensionBundle {
  skills: SkillDefinition[];
  agents: CustomAgentDef[];
  commands: CommandDefinition[];
  hooks: HooksConfig;
  mcpServers: Record<string, McpServerConfig>;
  plugins: DiscoveredPlugin[];
  problems: string[];
}

/** 装配所需的配置切面（WcodeConfig 的子集，便于测试注入） */
export interface ExtensionConfig {
  mcpServers: Record<string, McpServerConfig>;
  hooks: HooksConfig;
  plugins?: { enabled?: Record<string, boolean> };
}

interface InstalledDir {
  market: string;
  plugin: string;
  version: string;
  root: string;
}

async function scanInstalledDirs(pluginsDir: string): Promise<InstalledDir[]> {
  const out: InstalledDir[] = [];
  let markets;
  try {
    markets = await readdir(join(pluginsDir, "cache"), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const market of markets) {
    if (!market.isDirectory()) continue;
    let plugins;
    try {
      plugins = await readdir(join(pluginsDir, "cache", market.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const plugin of plugins) {
      if (!plugin.isDirectory()) continue;
      let versions;
      try {
        versions = await readdir(join(pluginsDir, "cache", market.name, plugin.name), {
          withFileTypes: true,
        });
      } catch {
        continue;
      }
      const sorted = versions
        .filter((v) => v.isDirectory())
        .map((v) => v.name)
        .sort(compareVersions);
      const latest = sorted[sorted.length - 1];
      if (latest) {
        out.push({
          market: market.name,
          plugin: plugin.name,
          version: latest,
          root: join(pluginsDir, "cache", market.name, plugin.name, latest),
        });
      }
    }
  }
  return out;
}

async function loadPluginSkills(
  info: PluginManifestInfo,
  problems: string[],
  ctx: { pluginRoot: string; cwd: string },
): Promise<SkillDefinition[]> {
  const out: SkillDefinition[] = [];
  const declared = componentPathsToList(info.manifest.skills);
  for (const dir of declared.length > 0 ? declared : ["skills"]) {
    const base = join(info.root, dir);
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      continue; // 插件没有该组件目录是常态
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!SKILL_NAME_RE.test(entry.name)) {
        problems.push(`插件 ${info.manifest.name} 的技能目录 "${entry.name}" 名字不合法，已跳过`);
        continue;
      }
      const path = join(base, entry.name, "SKILL.md");
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        problems.push(`插件 ${info.manifest.name} 的技能 ${entry.name} 缺少 SKILL.md，已跳过`);
        continue;
      }
      const parsed = parseSkillMarkdown(text);
      out.push({
        name: `${info.manifest.name}:${parsed.name ?? entry.name}`,
        description:
          parsed.description ??
          parsed.body.split("\n").find((l) => l.trim())?.slice(0, 100) ??
          "",
        body: substituteVars(parsed.body, ctx),
        source: "plugin",
        path,
      });
    }
  }
  return out;
}

async function loadPluginAgents(
  info: PluginManifestInfo,
  problems: string[],
  ctx: { pluginRoot: string; cwd: string },
): Promise<CustomAgentDef[]> {
  const out: CustomAgentDef[] = [];
  const declared = componentPathsToList(info.manifest.agents);
  for (const dir of declared.length > 0 ? declared : ["agents"]) {
    const base = join(info.root, dir);
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      let text: string;
      try {
        text = await readFile(join(base, entry.name), "utf8");
      } catch {
        problems.push(`插件 ${info.manifest.name} 的子 Agent 文件 ${entry.name} 读取失败，已跳过`);
        continue;
      }
      const parsed = parseAgentMarkdown(text);
      const name = parsed.name ?? entry.name.replace(/\.md$/i, "");
      if (!SKILL_NAME_RE.test(name)) {
        problems.push(`插件 ${info.manifest.name} 的子 Agent "${name}" 名字不合法，已跳过`);
        continue;
      }
      out.push({
        name: `${info.manifest.name}:${name}`,
        description: parsed.description ?? "",
        tools: parseToolsField(parsed.tools),
        body: substituteVars(parsed.body, ctx),
        source: "plugin",
        path: join(base, entry.name),
      });
    }
  }
  return out;
}

async function loadPluginCommands(
  info: PluginManifestInfo,
  problems: string[],
  ctx: { pluginRoot: string; cwd: string },
): Promise<CommandDefinition[]> {
  const out: CommandDefinition[] = [];
  const declared = componentPathsToList(info.manifest.commands);
  for (const dir of declared.length > 0 ? declared : ["commands"]) {
    const found = await scanCommandDir(join(info.root, dir), "plugin", problems, info.manifest.name);
    out.push(...found.map((c) => ({ ...c, body: substituteVars(c.body, ctx) })));
  }
  return out;
}

async function loadPluginHooks(
  info: PluginManifestInfo,
  problems: string[],
): Promise<Partial<Omit<HooksConfig, "timeoutMs">>> {
  const hooksPath = join(info.root, info.manifest.hooks ?? join("hooks", "hooks.json"));
  let raw: string;
  try {
    raw = await readFile(hooksPath, "utf8");
  } catch (err) {
    const msg = errorMessage(err);
    if (!msg.includes("ENOENT")) {
      problems.push(`插件 ${info.manifest.name} 的 hooks 读取失败: ${msg}`);
    }
    return {};
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    problems.push(`插件 ${info.manifest.name} 的 hooks.json 不是合法 JSON: ${errorMessage(err)}`);
    return {};
  }
  const result = parseHooksFile(json, `插件 ${info.manifest.name} 的 hooks.json`);
  problems.push(...result.problems);
  return result.events;
}

/** 变量替换：${WCODE_PLUGIN_ROOT}（含 ZCODE/CLAUDE 别名）→ 插件根；${WCODE_PROJECT_DIR}（含 CLAUDE 别名）→ cwd */
function substituteVars(
  text: string,
  ctx: { pluginRoot: string; cwd: string },
): string {
  return text
    .replaceAll("${WCODE_PLUGIN_ROOT}", ctx.pluginRoot)
    .replaceAll("${ZCODE_PLUGIN_ROOT}", ctx.pluginRoot)
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", ctx.pluginRoot)
    .replaceAll("${WCODE_PROJECT_DIR}", ctx.cwd)
    .replaceAll("${CLAUDE_PROJECT_DIR}", ctx.cwd);
}

/** 变量替换（MCP 声明）：同上，并识别 ${user_config.*} 未实现并提示 */
function substituteMcpVars(
  spec: McpServerConfig,
  ctx: { pluginRoot: string; cwd: string; pluginName: string; problems: string[] },
): McpServerConfig {
  const sub = (s: string): string => substituteVars(s, ctx);
  const result: McpServerConfig = { ...spec };
  if (result.command) result.command = sub(result.command);
  if (result.args) result.args = result.args.map(sub);
  if (result.url) result.url = sub(result.url);
  if (result.env) {
    result.env = Object.fromEntries(Object.entries(result.env).map(([k, v]) => [k, sub(v)]));
  }
  if (result.headers) {
    result.headers = Object.fromEntries(
      Object.entries(result.headers).map(([k, v]) => [k, sub(v)]),
    );
  }
  if (JSON.stringify(result).includes("${user_config.")) {
    ctx.problems.push(
      `插件 ${ctx.pluginName} 的 MCP 声明使用了 \${user_config.*} 引用：wcode 暂未实现插件用户配置，已保留原文（该 server 可能连接失败）`,
    );
  }
  return result;
}

async function loadRawMcpServers(
  info: PluginManifestInfo,
  problems: string[],
): Promise<Record<string, unknown>> {
  const declared = info.manifest.mcpServers;
  const read = async (path: string): Promise<Record<string, unknown> | null> => {
    try {
      const json = JSON.parse(await readFile(path, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      if (json && typeof json === "object" && json.mcpServers) return json.mcpServers;
      problems.push(`插件 ${info.manifest.name} 的 MCP 文件 ${path} 缺少 mcpServers 字段，已跳过`);
      return null;
    } catch (err) {
      const msg = errorMessage(err);
      if (!msg.includes("ENOENT")) {
        problems.push(`插件 ${info.manifest.name} 的 MCP 文件 ${path} 读取失败: ${msg}`);
      }
      return null;
    }
  };
  if (declared === undefined) {
    return (await read(join(info.root, ".mcp.json"))) ?? {};
  }
  if (typeof declared === "string" || Array.isArray(declared)) {
    const out: Record<string, unknown> = {};
    for (const p of componentPathsToList(declared)) {
      const servers = await read(join(info.root, p));
      if (servers) Object.assign(out, servers);
    }
    return out;
  }
  return declared as Record<string, unknown>;
}

async function loadPluginMcp(
  info: PluginManifestInfo,
  opts: { cwd: string },
  problems: string[],
): Promise<Record<string, McpServerConfig>> {
  const rawServers = await loadRawMcpServers(info, problems);
  const out: Record<string, McpServerConfig> = {};
  for (const [serverName, spec] of Object.entries(rawServers)) {
    const parsed = mcpServerSpecSchema.safeParse(spec);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      problems.push(
        `插件 ${info.manifest.name} 的 MCP 服务器 "${serverName}" 不合法：${issue?.message ?? "校验失败"}，已跳过`,
      );
      continue;
    }
    out[`plugin:${info.manifest.name}:${serverName}`] = substituteMcpVars(parsed.data, {
      pluginRoot: info.root,
      cwd: opts.cwd,
      pluginName: info.manifest.name,
      problems,
    });
  }
  return out;
}

/** 插件目录 → 组件加载。清单解析失败抛错由上层转 problem（安装损坏要报清楚） */
async function loadPluginComponents(
  info: PluginManifestInfo,
  opts: { cwd: string },
): Promise<
  Pick<DiscoveredPlugin, "skills" | "agents" | "commands" | "mcpServers" | "hooks" | "problems">
> {
  const problems: string[] = [];
  const ctx = { pluginRoot: info.root, cwd: opts.cwd };
  const [skills, agents, commands] = await Promise.all([
    loadPluginSkills(info, problems, ctx),
    loadPluginAgents(info, problems, ctx),
    loadPluginCommands(info, problems, ctx),
  ]);
  const hooks = await loadPluginHooks(info, problems);
  const mcpServers = await loadPluginMcp(info, opts, problems);
  return { skills, agents, commands, mcpServers, hooks, problems };
}

/** 扫描已安装插件并加载组件（禁用插件只保留元信息，不加载组件） */
export async function discoverInstalledPlugins(opts: {
  cwd: string;
  homeDir?: string;
  config: ExtensionConfig;
}): Promise<{ plugins: DiscoveredPlugin[]; problems: string[] }> {
  const pluginsDir = defaultPluginsDir(opts.homeDir);
  const problems: string[] = [];
  const plugins: DiscoveredPlugin[] = [];
  for (const dir of await scanInstalledDirs(pluginsDir)) {
    const seed = await readSeed(dir.root);
    const market = seed?.marketplace ?? dir.market;
    const plugin = seed?.plugin ?? dir.plugin;
    const enabled = opts.config.plugins?.enabled?.[`${plugin}@${market}`] !== false;
    let info: PluginManifestInfo | null = null;
    try {
      info = await findPluginManifest(dir.root);
    } catch (err) {
      problems.push(`插件 ${plugin}@${market} 清单解析失败: ${errorMessage(err)}`);
      continue;
    }
    if (!info) {
      problems.push(
        `插件 ${plugin}@${market}（${dir.version}）缺少 plugin.json，安装已损坏，请卸载后重装`,
      );
      continue;
    }
    const components = enabled
      ? await loadPluginComponents(info, { cwd: opts.cwd })
      : { skills: [], agents: [], commands: [], mcpServers: {}, hooks: {}, problems: [] };
    problems.push(...components.problems);
    plugins.push({
      name: info.manifest.name,
      version: info.manifest.version,
      description: info.manifest.description,
      marketplace: market,
      enabled,
      root: dir.root,
      manifestPath: info.path,
      format: info.format,
      ...components,
    });
  }
  return { plugins, problems };
}

/** 插件唯一键（启停标记、UI 键） */
export function pluginKey(name: string, market: string): string {
  return `${name}@${market}`;
}

/**
 * 扩展装配总入口：用户/项目发现 + 已安装插件组件合并。
 * CLI refreshRuntime 与桌面 runtime 共用，保证两端行为一致。
 */
export async function assembleExtensions(opts: {
  cwd: string;
  homeDir?: string;
  config: ExtensionConfig;
}): Promise<ExtensionBundle> {
  const [skillsRes, agentsRes, commandsRes, pluginRes] = await Promise.all([
    discoverSkills({ cwd: opts.cwd, homeDir: opts.homeDir }),
    discoverAgents({ cwd: opts.cwd, homeDir: opts.homeDir }),
    discoverCommands({ cwd: opts.cwd, homeDir: opts.homeDir }),
    discoverInstalledPlugins({ cwd: opts.cwd, homeDir: opts.homeDir, config: opts.config }),
  ]);
  const problems = [
    ...skillsRes.problems,
    ...agentsRes.problems,
    ...commandsRes.problems,
    ...pluginRes.problems,
  ];

  const skills = [...skillsRes.items];
  const agents = [...agentsRes.items];
  const commands = [...commandsRes.items];
  const seenSkill = new Set(skills.map((s) => s.name));
  const seenAgent = new Set(agents.map((a) => a.name));
  const seenCommand = new Set(commands.map((c) => c.qualifiedName));
  const mcpServers: Record<string, McpServerConfig> = { ...opts.config.mcpServers };
  const hooks: HooksConfig = { ...opts.config.hooks };

  for (const plugin of pluginRes.plugins) {
    if (!plugin.enabled) continue;
    for (const skill of plugin.skills) {
      if (seenSkill.has(skill.name)) {
        problems.push(`插件技能 "${skill.name}" 与既有技能重名，插件版已忽略`);
        continue;
      }
      seenSkill.add(skill.name);
      skills.push(skill);
    }
    for (const agent of plugin.agents) {
      if (seenAgent.has(agent.name)) {
        problems.push(`插件子 Agent "${agent.name}" 与既有子 Agent 重名，插件版已忽略`);
        continue;
      }
      seenAgent.add(agent.name);
      agents.push(agent);
    }
    for (const cmd of plugin.commands) {
      if (seenCommand.has(cmd.qualifiedName)) {
        problems.push(`插件命令 "${cmd.qualifiedName}" 与既有命令重名，插件版已忽略`);
        continue;
      }
      seenCommand.add(cmd.qualifiedName);
      commands.push(cmd);
    }
    for (const [key, cfg] of Object.entries(plugin.mcpServers)) {
      if (mcpServers[key]) {
        problems.push(`MCP 服务器 "${key}" 重名（配置与插件），配置版优先`);
        continue;
      }
      mcpServers[key] = cfg;
    }
    for (const key of HOOK_EVENT_KEYS) {
      const extra = plugin.hooks[key];
      if (extra && extra.length > 0) {
        hooks[key] = [...hooks[key], ...extra];
      }
    }
  }

  return { skills, agents, commands, hooks, mcpServers, plugins: pluginRes.plugins, problems };
}
