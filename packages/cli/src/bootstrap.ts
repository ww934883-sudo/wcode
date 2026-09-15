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
  createFileLogger,
  createAgentsMdSection,
  createMcpToolSource,
  defaultPromptSections,
  errorMessage,
  findLatestSessionFile,
  loadAgentsMdFiles,
  loadConfig,
  messagesFromSessionLines,
  parseLogLevel,
  parseRuleString,
  projectDirHash,
  type WcodeConfig,
  type Logger,
  type Message,
  type ModelProvider,
  type AgentHost,
  type PromptSection,
} from "@wcode/core";
import { AnthropicProvider } from "@wcode/provider-anthropic";
import {
  bashTool,
  editTool,
  globTool,
  grepTool,
  readTool,
  todoReadTool,
  todoWriteTool,
  taskTool,
  writeTool,
  taskOutputTool,
  taskStopTool,
} from "@wcode/core";
import type { Tool } from "@wcode/core";

export const BUILTIN_TOOLS: Tool[] = [
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  bashTool,
  todoWriteTool,
  todoReadTool,
  taskOutputTool,
  taskStopTool,
  taskTool,
];

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
  if (providerCfg.type !== "anthropic") {
    throw new ConfigError(
      `provider 类型 "${providerCfg.type}" 的适配器尚未实现（openai-compatible 在 W2 提供）`,
    );
  }
  const apiKey = process.env[providerCfg.apiKeyEnv] ?? "";
  if (!apiKey) {
    throw new ConfigError(
      `缺少 API key：请设置环境变量 ${providerCfg.apiKeyEnv}` +
        `（或修改 ~/.wcode/settings.json 中 providers.${config.activeProvider}.apiKeyEnv 指向其他变量名）`,
    );
  }
  return new AnthropicProvider({
    apiKey,
    model: config.model,
    baseUrl: providerCfg.baseUrl,
  });
}

export interface Bootstrap {
  session: AgentSession;
  config: WcodeConfig;
  log: Logger;
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

  const provider =
    options.provider ?? (await createProvider(config));

  const registry = new ToolRegistry();
  await registry.registerSource({ id: "builtin", listTools: () => BUILTIN_TOOLS });

  // MCP servers：连接失败降级跳过，不阻塞启动（架构文档 §11）
  for (const [name, cfg] of Object.entries(config.mcpServers ?? {})) {
    try {
      registry.registerSource(await createMcpToolSource(name, cfg));
      log.info("mcp.connected", { server: name });
    } catch (err) {
      log.warn("mcp.connect-failed", { server: name, error: errorMessage(err) });
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

  // 项目记忆：AGENTS.md（兼容 CLAUDE.md）→ PromptSection
  const agentsMd = await loadAgentsMdFiles({ cwd });
  const agentsMdSection = createAgentsMdSection(agentsMd);
  const sections: PromptSection[] = [
    ...defaultPromptSections,
    ...(agentsMdSection ? [agentsMdSection] : []),
  ];

  const session = new AgentSession({
    provider,
    registry,
    engine,
    host: options.host,
    system: buildSystemPrompt(sections, {
      cwd,
      platform: process.platform,
    }),
    cwd,
    store,
    log,
    bashTimeoutMs: config.tools.bashTimeoutMs,
    maxContextTokens: config.context.maxContextTokens,
    compactThreshold: config.context.compactThreshold,
    initialMessages,
  });

  return { session, config, log };
}
