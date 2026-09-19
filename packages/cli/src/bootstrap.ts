import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentSession,
  ConfigError,
  PermissionEngine,
  ToolRegistry,
  assembleExtensions,
  buildSystemPrompt,
  createBuiltinToolSource,
  createFileLogger,
  createAgentsMdSection,
  createMcpToolSource,
  createSkillsSection,
  createSessionDriver,
  defaultPluginsDir,
  defaultPromptSections,
  errorMessage,
  loadAgentsMdFiles,
  loadConfig,
  messagesFromSessionLines,
  parseLogLevel,
  parseRuleString,
  runHooks,
  seedBuiltinPlugins,
  type WcodeConfig,
  type CommandDefinition,
  type CustomAgentDef,
  type DiscoveredPlugin,
  type Logger,
  type Message,
  type ModelProvider,
  type AgentHost,
  type PromptSection,
  type SessionDriver,
  type SessionStore,
  type SkillDefinition,
  type ToolSource,
} from "@wcode/core";
import { AnthropicProvider } from "@wcode/provider-anthropic";
import { OpenAIChatProvider, OpenAIResponsesProvider } from "@wcode/provider-openai";

/** 内置插件根目录（仓库 packages/core/plugins-builtin）；环境变量可覆盖；解析失败返回 null */
function builtinPluginsDir(): string | null {
  const env = process.env.WCODE_BUILTIN_PLUGINS_DIR;
  if (env) return env;
  try {
    return fileURLToPath(new URL("../../core/plugins-builtin", import.meta.url));
  } catch {
    return null;
  }
}

export async function createProvider(
  config: WcodeConfig,
): Promise<ModelProvider> {
  const providerCfg = config.providers[config.activeProvider];
  if (!providerCfg) {
    throw new ConfigError(
      `activeProvider "${config.activeProvider}" 在 providers 中不存在。` +
        `可用: ${Object.keys(config.providers).join(", ")}`,
    );
  }
  const apiKey = providerCfg.apiKey ?? process.env[providerCfg.apiKeyEnv] ?? "";
  if (!apiKey) {
    throw new ConfigError(
      `缺少 API key：请在 ~/.wcode/settings.json 的 providers.${config.activeProvider} 里配置` +
        ` apiKey（用户级）或 apiKeyEnv 指向的环境变量`,
    );
  }
  if (providerCfg.type === "anthropic") {
    return new AnthropicProvider({
      apiKey,
      model: config.model,
      baseUrl: providerCfg.baseUrl,
    });
  }
  if (providerCfg.type === "openai-compatible") {
    return new OpenAIChatProvider({
      apiKey,
      model: config.model,
      baseUrl: providerCfg.baseUrl,
    });
  }
  return new OpenAIResponsesProvider({
    apiKey,
    model: config.model,
    baseUrl: providerCfg.baseUrl,
  });
}

export interface RuntimeSnapshot {
  config: WcodeConfig;
  registry: ToolRegistry;
  engine: PermissionEngine;
  system: string;
  skills: SkillDefinition[];
  /** 自定义斜杠命令（用户/项目/插件），内置命令之后、技能映射之前匹配 */
  commands: CommandDefinition[];
  /** 已安装插件元信息（/plugin 列表展示用） */
  plugins: DiscoveredPlugin[];
  customAgents: CustomAgentDef[];
  /** 非致命问题（非法技能/子 Agent 定义等），已跳过对应条目 */
  problems: string[];
}

/**
 * 装配运行时快照：加载配置 → 发现 skills/agents/commands + 已安装插件组件
 * → 组装工具注册表/权限引擎/系统提示。
 * bootstrap（启动）与 /reload（热更新）共用；变更这些文件后无需重启。
 */
export async function refreshRuntime(opts: {
  cwd: string;
  log: Logger;
  /** CLI 层覆盖（如 --mode），/reload 时必须透传保持一致 */
  overrides?: Record<string, unknown>;
  /** 已加载的配置（bootstrap 传入避免重复读盘）；/reload 省略即重新读 */
  config?: WcodeConfig;
  /** /reload 时复用旧注册表的非内置 source（MCP 连接不重建） */
  carryOverSources?: ToolSource[];
}): Promise<RuntimeSnapshot> {
  const loaded = opts.config ?? (await loadConfig({ overrides: opts.overrides, cwd: opts.cwd }));

  const bundle = await assembleExtensions({
    cwd: opts.cwd,
    config: loaded,
  });
  for (const problem of bundle.problems) {
    opts.log.warn("discover.problem", { problem });
  }

  // 插件组件合入后的配置视图（/mcp 等命令与 MCP 装配共用同一份）
  const config: WcodeConfig = {
    ...loaded,
    mcpServers: bundle.mcpServers,
    hooks: bundle.hooks,
  };

  // 内置工具源统一由工厂创建（有技能时才注册 skill 工具，task 工具带子 Agent 目录）
  const registry = new ToolRegistry();
  await registry.registerSource(
    createBuiltinToolSource({ skills: bundle.skills, agents: bundle.agents }),
  );
  // /reload：迁移旧注册表的非内置 source（MCP 连接保持存活，避免重建子进程）
  for (const source of opts.carryOverSources ?? []) {
    await registry.registerSource(source);
  }

  // MCP servers（含插件命名空间 server）：连接失败降级跳过，不阻塞启动（架构文档 §11）。
  // /reload 已迁移的 source 不重建（重复注册会触发工具名冲突）
  const carriedIds = new Set((opts.carryOverSources ?? []).map((s) => s.id));
  for (const [name, cfg] of Object.entries(config.mcpServers ?? {})) {
    if (carriedIds.has(`mcp:${name}`)) continue;
    try {
      registry.registerSource(await createMcpToolSource(name, cfg));
      opts.log.info("mcp.connected", { server: name });
    } catch (err) {
      opts.log.warn("mcp.connect-failed", { server: name, error: errorMessage(err) });
    }
  }

  const rules = [
    ...config.permissions.allow.map((s) => parseRuleString(s, "allow", "config")),
    ...config.permissions.deny.map((s) => parseRuleString(s, "deny", "config")),
  ];
  const engine = new PermissionEngine({
    rules,
    mode: config.permissions.mode,
  });

  // 项目记忆 + 技能清单：AGENTS.md（兼容 CLAUDE.md）/ Skills → PromptSection
  const agentsMd = await loadAgentsMdFiles({ cwd: opts.cwd });
  const agentsMdSection = createAgentsMdSection(agentsMd);
  const skillsSection = createSkillsSection(bundle.skills);
  const sections: PromptSection[] = [
    ...defaultPromptSections,
    ...(agentsMdSection ? [agentsMdSection] : []),
    ...(skillsSection ? [skillsSection] : []),
  ];
  const system = buildSystemPrompt(sections, {
    cwd: opts.cwd,
    platform: process.platform,
  });

  return {
    config,
    registry,
    engine,
    system,
    skills: bundle.skills,
    commands: bundle.commands,
    plugins: bundle.plugins,
    customAgents: bundle.agents,
    problems: bundle.problems,
  };
}

export interface Bootstrap {
  session: AgentSession;
  config: WcodeConfig;
  log: Logger;
  /** 当前激活的 provider（斜杠命令 /btw 直答、/model 切换用） */
  provider: ModelProvider;
  /** 已发现的技能（供 UI 层做 /技能名 映射） */
  skills: SkillDefinition[];
  /** 自定义斜杠命令（/命令名 调用，内置命令之后匹配） */
  commands: CommandDefinition[];
  /** 会话工作目录（/reload 用） */
  cwd: string;
  /** 会话存储驱动（/resume 列表与打开） */
  sessions: SessionDriver;
  /** 当前会话 id（headless JSON 输出、自动化回链用） */
  sessionId: string;
  /** 当前工具注册表（/reload 迁移 MCP source 用） */
  registry: ToolRegistry;
  /** CLI 层覆盖（/reload 透传） */
  overrides?: Record<string, unknown>;
}

export async function bootstrap(options: {
  /** UI 必须先行创建（readline 依赖），注入给 AgentSession */
  host: AgentHost;
  overrides?: Record<string, unknown>;
  cwd?: string;
  /** 家目录覆盖（测试隔离 ~/.wcode；缺省 homedir()） */
  homeDir?: string;
  /** 测试/自检注入假 provider；缺省按配置创建真实 provider */
  provider?: ModelProvider;
  /** 会话恢复：true 接最近一次会话；字符串按 sessionId 恢复 */
  resume?: boolean | string;
}): Promise<Bootstrap> {
  const cwd = options.cwd ?? process.cwd();
  const config = await loadConfig({ overrides: options.overrides, cwd });

  const log = createFileLogger({
    dir: join(homedir(), ".wcode", "logs"),
    name: `wcode-${new Date().toISOString().slice(0, 10)}`,
    level: parseLogLevel(process.env.WCODE_LOG) ?? config.log.level,
  });

  // 内置插件播种：随应用分发的插件装进本机缓存（默认启用；升级重装；卸载过的不装回）。
  // 失败降级为日志，不阻塞启动
  const builtinDir = builtinPluginsDir();
  if (builtinDir) {
    try {
      const seeded = await seedBuiltinPlugins({
        pluginsDir: defaultPluginsDir(join(options.homeDir ?? homedir(), ".wcode")),
        builtinDir,
        blockedBuiltins: config.plugins.blockedBuiltins,
      });
      for (const problem of seeded.problems) log.warn("plugin.seed-problem", { problem });
      if (seeded.seeded.length > 0) log.info("plugin.seeded", { plugins: seeded.seeded });
    } catch (err) {
      log.warn("plugin.seed-failed", { error: errorMessage(err) });
    }
  }

  const snap = await refreshRuntime({ cwd, log, overrides: options.overrides, config });
  const { registry, engine, system } = snap;

  const provider =
    options.provider ?? (await createProvider(snap.config));

  // 会话持久化 / 恢复：driver 按 storage.type 装配（sqlite 默认 / jsonl 回退），
  // sqlite 首次运行会把旧 JSONL 一次性导入 ~/.wcode/wcode.db（幂等，见设计 §5）
  const sessions = await createSessionDriver({
    storageType: snap.config.storage.type,
    cwd,
    log,
    homeDir: options.homeDir,
  });
  let store: SessionStore;
  let sessionId: string;
  let initialMessages: Message[] | undefined;
  if (options.resume) {
    const id =
      typeof options.resume === "string"
        ? options.resume
        : await sessions.findLatest();
    if (!id) {
      throw new ConfigError("没有可恢复的会话（该目录下无历史会话记录）");
    }
    store = await sessions.open(id);
    sessionId = id;
    initialMessages = messagesFromSessionLines(await store.load());
    log.info("session.resumed", { sessionId: id, messages: initialMessages.length });
  } else {
    const created = await sessions.createNew({ cwd });
    store = created.store;
    sessionId = created.sessionId;
  }

  // session_start hooks：失败/超时降级为日志，不阻塞启动
  if (snap.config.hooks.sessionStart.length > 0) {
    try {
      const outcome = await runHooks("session_start", snap.config.hooks, { cwd }, { cwd });
      for (const notice of outcome.notices) log.warn("hook.notice", { event: "session_start", notice });
    } catch (err) {
      log.warn("hook.notice", { event: "session_start", error: errorMessage(err) });
    }
  }

  const session = new AgentSession({
    provider,
    registry,
    engine,
    host: options.host,
    system,
    cwd,
    store,
    log,
    bashTimeoutMs: snap.config.tools.bashTimeoutMs,
    maxContextTokens: snap.config.context.maxContextTokens,
    compactThreshold: snap.config.context.compactThreshold,
    initialMessages,
    hooks: snap.config.hooks,
    customAgents: snap.customAgents,
  });

  return {
    session,
    config: snap.config,
    log,
    provider,
    skills: snap.skills,
    commands: snap.commands,
    cwd,
    sessions,
    sessionId,
    registry,
    overrides: options.overrides,
  };
}
