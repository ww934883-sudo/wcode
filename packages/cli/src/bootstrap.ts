import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AgentSession,
  ConfigError,
  JsonlSessionStore,
  PermissionEngine,
  ToolRegistry,
  buildSystemPrompt,
  createBuiltinToolSource,
  createFileLogger,
  createAgentsMdSection,
  createMcpToolSource,
  createSkillsSection,
  defaultPromptSections,
  discoverAgents,
  discoverSkills,
  errorMessage,
  findLatestSessionFile,
  loadAgentsMdFiles,
  loadConfig,
  messagesFromSessionLines,
  parseLogLevel,
  parseRuleString,
  projectDirHash,
  runHooks,
  type WcodeConfig,
  type CustomAgentDef,
  type Logger,
  type Message,
  type ModelProvider,
  type AgentHost,
  type PromptSection,
  type SkillDefinition,
  type ToolSource,
} from "@wcode/core";
import { AnthropicProvider } from "@wcode/provider-anthropic";
import { OpenAIChatProvider, OpenAIResponsesProvider } from "@wcode/provider-openai";

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
  customAgents: CustomAgentDef[];
  /** 非致命问题（非法技能/子 Agent 定义等），已跳过对应条目 */
  problems: string[];
}

/**
 * 装配运行时快照：加载配置 → 发现 skills/agents → 组装工具注册表/权限引擎/系统提示。
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
  const config = opts.config ?? (await loadConfig({ overrides: opts.overrides, cwd: opts.cwd }));

  const [skillsRes, agentsRes] = await Promise.all([
    discoverSkills({ cwd: opts.cwd }),
    discoverAgents({ cwd: opts.cwd }),
  ]);
  for (const problem of [...skillsRes.problems, ...agentsRes.problems]) {
    opts.log.warn("discover.problem", { problem });
  }

  // 内置工具源统一由工厂创建（有技能时才注册 skill 工具，task 工具带子 Agent 目录）
  const registry = new ToolRegistry();
  await registry.registerSource(
    createBuiltinToolSource({ skills: skillsRes.items, agents: agentsRes.items }),
  );
  // /reload：迁移旧注册表的非内置 source（MCP 连接保持存活，避免重建子进程）
  for (const source of opts.carryOverSources ?? []) {
    await registry.registerSource(source);
  }

  // MCP servers：连接失败降级跳过，不阻塞启动（架构文档 §11）
  for (const [name, cfg] of Object.entries(config.mcpServers ?? {})) {
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
  const skillsSection = createSkillsSection(skillsRes.items);
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
    skills: skillsRes.items,
    customAgents: agentsRes.items,
    problems: [...skillsRes.problems, ...agentsRes.problems],
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
  /** 会话工作目录（/reload 用） */
  cwd: string;
  /** 会话记录目录（/resume 列表用） */
  sessionsDir: string;
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

  const snap = await refreshRuntime({ cwd, log, overrides: options.overrides, config });
  const { registry, engine, system } = snap;

  const provider =
    options.provider ?? (await createProvider(snap.config));

  // 会话持久化 / 恢复：~/.wcode/projects/<路径哈希>/<时间戳>.jsonl
  const sessionsDir = join(
    homedir(),
    ".wcode",
    "projects",
    projectDirHash(cwd),
  );
  await mkdir(sessionsDir, { recursive: true }).catch(() => {});
  let store: JsonlSessionStore;
  let initialMessages: Message[] | undefined;
  if (options.resume) {
    const file =
      typeof options.resume === "string"
        ? join(sessionsDir, `${options.resume}.jsonl`)
        : await findLatestSessionFile(sessionsDir);
    if (!file) {
      throw new ConfigError("没有可恢复的会话（该目录下无历史会话文件）");
    }
    store = new JsonlSessionStore(file, log);
    initialMessages = messagesFromSessionLines(await store.load());
    log.info("session.resumed", { file, messages: initialMessages.length });
  } else {
    const sessionId = new Date().toISOString().replace(/[:.]/g, "-");
    store = new JsonlSessionStore(join(sessionsDir, `${sessionId}.jsonl`), log);
    await store
      .append({ v: 1, type: "meta", sessionId, createdAt: new Date().toISOString(), cwd })
      .catch(() => {});
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
    cwd,
    sessionsDir,
    registry,
    overrides: options.overrides,
  };
}
