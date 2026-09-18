import { homedir } from "node:os";
import path from "node:path";
import {
  AgentSession,
  PermissionEngine,
  ToolRegistry,
  buildSystemPrompt,
  createBuiltinToolSource,
  createMcpToolSource,
  createSessionDriver,
  defaultPromptSections,
  discoverAgents,
  discoverSkills,
  errorMessage,
  loadConfig,
  messagesFromSessionLines,
  parseRuleString,
  type AgentEvent,
  type AgentHost,
  type CustomAgentDef,
  type McpServerConfig,
  type Message,
  type ModelProvider,
  type PermissionDecision,
  type PermissionRequest,
  type PromptSection,
  type SessionDriver,
  type SessionStore,
  type SkillDefinition,
  type WcodeConfig,
} from "@wcode/core";
import { AnthropicProvider } from "@wcode/provider-anthropic";
import { OpenAIChatProvider, OpenAIResponsesProvider } from "@wcode/provider-openai";
import type { PermissionMode, RuntimeInfo, SearchHitEntry, SessionEntry, ThinkingLevel } from "../shared/protocol";
import type { AutomationDeps } from "./automation";
import { AutomationDesk } from "./automation";
import { buildDemoTurns, ScriptedProvider } from "./demo-script";
import { prepareDemoWorkspace } from "./demo-workspace";
import { patchUserSettings } from "./settings";

const DEMO_MODELS = ["wcode-demo", "wcode-demo-fast"];

interface DeskSession {
  id: string;
  cwd: string;
  session: AgentSession;
  store: SessionStore;
  running: boolean;
  provider: ModelProvider;
}

export interface RuntimeCallbacks {
  /** 任意状态变更后通知渲染层刷新 info */
  onInfo: () => void;
}

/**
 * 桌面运行时 v2（组合根）：多会话/多项目管理 + jsonl 持久化 + 检查点分叉 +
 * 模型热切 + MCP/Skills/助理装配 + 设置落盘。core 零改动，全部走既有接缝。
 * 演示模式：模型输出为脚本，工具、权限、会话存储全部真实。
 */
export class DesktopRuntime {
  mode: "demo" | "real" = "demo";
  notice?: string;
  model = "";
  contextTokens = 200_000;
  permissionMode: PermissionMode = "default";
  thinkingLevel: ThinkingLevel = "medium";
  persona: string | null = null;
  currentCwd = process.cwd();

  private config: WcodeConfig | null = null;
  private apiKey = "";
  private realProvider: ModelProvider | null = null;
  private registry = new ToolRegistry();
  private mcpConnected = new Set<string>();
  private mcpDisabled = new Set<string>();
  private mcpProblems: string[] = [];
  private drivers = new Map<string, SessionDriver>();
  private sessions = new Map<string, DeskSession>();
  private agents: CustomAgentDef[] = [];
  private skills: SkillDefinition[] = [];
  private readonly homeDir: string;
  private automationDesk: AutomationDesk | null = null;

  constructor(
    private readonly host: {
      emit(sessionId: string, ev: AgentEvent): void;
      requestPermission(sessionId: string, req: PermissionRequest): Promise<PermissionDecision>;
      resolve(askId: string, decision: PermissionDecision): void;
    },
    private readonly opts: { userDataDir: string; demo: boolean; cb: RuntimeCallbacks },
  ) {
    this.homeDir = opts.demo ? path.join(opts.userDataDir, "home") : homedir();
  }

  async init(): Promise<void> {
    try {
      this.config = await loadConfig({ overrides: {}, cwd: this.currentCwd, homeDir: path.join(this.homeDir, ".wcode") });
    } catch (err) {
      this.config = null;
      this.notice = `配置加载失败（${errorMessage(err)}）`;
    }
    if (this.opts.demo) {
      this.notice = "演示模式：模型输出为本地脚本，工具、权限、会话存储真实执行";
    } else {
      const cfg = this.config?.providers[this.activeProviderName()];
      const key = cfg?.apiKey ?? (cfg ? (process.env[cfg.apiKeyEnv] ?? "") : "");
      if (!this.config || !cfg || !key) {
        this.mode = "demo";
        this.notice = "未检测到 API key（~/.wcode/settings.json），当前为演示模式";
      } else {
        this.mode = "real";
        this.apiKey = key;
      }
    }
    this.model = this.mode === "real" ? (this.config?.model ?? "") : (DEMO_MODELS[0] ?? "wcode-demo");
    if (this.mode === "real") {
      this.realProvider = this.buildRealProvider(this.model);
    }
    await this.rebuildRegistry();
    await this.refreshDiscoveries();
    if (this.mode === "demo") {
      this.currentCwd = await prepareDemoWorkspace(this.opts.userDataDir);
    }
    // 自动化调度台：主进程内置 tick，与 CLI daemon 共库（claim 互斥防双跑）
    this.automationDesk = new AutomationDesk(this.automationDeps());
    this.automationDesk.start();
  }

  /** 应用退出时释放：停调度器并关闭 SQLite 连接（WAL 检查点） */
  dispose(): void {
    this.automationDesk?.stop();
    this.automationDesk = null;
  }

  private automationDeps(): AutomationDeps {
    return {
      homeDir: this.homeDir,
      providerFor: (cwd) => this.providerFor(cwd),
      registry: () => this.registry,
      systemFor: (cwd) => this.systemFor(cwd),
      permissionRules: () =>
        this.config
          ? { allow: [...this.config.permissions.allow], deny: [...this.config.permissions.deny] }
          : { allow: [], deny: [] },
      driverFor: (cwd) => this.driverFor(cwd),
      thinking: () => this.thinkingLevel,
      onChanged: () => this.opts.cb.onInfo(),
    };
  }

  private desk(): AutomationDesk {
    if (!this.automationDesk) throw new Error("自动化调度台未就绪");
    return this.automationDesk;
  }

  listAutomations() {
    return this.desk().list();
  }

  addAutomation(spec: Parameters<AutomationDesk["add"]>[0]) {
    return this.desk().add(spec);
  }

  removeAutomation(id: string) {
    return this.desk().remove(id);
  }

  setAutomationEnabled(id: string, enabled: boolean) {
    return this.desk().setEnabled(id, enabled);
  }

  runAutomation(id: string) {
    return this.desk().runManually(id);
  }

  listAutomationRuns(id: string) {
    return this.desk().runs(id);
  }

  private activeProviderName(): string {
    return this.config?.activeProvider ?? "";
  }

  private buildRealProvider(model: string): ModelProvider {
    const config = this.config;
    if (!config) throw new Error("配置未加载");
    const cfg = config.providers[config.activeProvider];
    if (!cfg) throw new Error(`activeProvider "${config.activeProvider}" 不存在`);
    if (cfg.type === "anthropic") {
      return new AnthropicProvider({ apiKey: this.apiKey, model, baseUrl: cfg.baseUrl });
    }
    if (cfg.type === "openai-compatible") {
      return new OpenAIChatProvider({ apiKey: this.apiKey, model, baseUrl: cfg.baseUrl });
    }
    return new OpenAIResponsesProvider({ apiKey: this.apiKey, model, baseUrl: cfg.baseUrl });
  }

  private providerFor(cwd: string): ModelProvider {
    if (this.mode === "demo") {
      return new ScriptedProvider(buildDemoTurns(cwd));
    }
    return this.realProvider ?? this.buildRealProvider(this.model);
  }

  /** MCP：真实模式连接启用的 server；失败降级为问题清单不阻塞启动 */
  private async rebuildRegistry(): Promise<void> {
    const registry = new ToolRegistry();
    await registry.registerSource(createBuiltinToolSource({ skills: [], agents: [] }));
    this.mcpConnected.clear();
    this.mcpProblems = [];
    const servers = this.config?.mcpServers ?? {};
    for (const [name, cfg] of Object.entries(servers)) {
      if (this.mcpDisabled.has(name)) continue;
      try {
        await registry.registerSource(await createMcpToolSource(name, cfg));
        this.mcpConnected.add(name);
      } catch (err) {
        this.mcpProblems.push(`MCP ${name}: ${errorMessage(err)}`);
      }
    }
    this.registry = registry;
  }

  async refreshDiscoveries(): Promise<void> {
    const cwd = this.currentCwd;
    const fallback = { items: [], problems: [] as string[] };
    const [skillsRes, agentsRes] = await Promise.all([
      discoverSkills({ cwd }).catch(() => fallback),
      discoverAgents({ cwd }).catch(() => fallback),
    ]);
    this.skills = skillsRes.items;
    this.agents = agentsRes.items;
  }

  private async driverFor(cwd: string): Promise<SessionDriver> {
    let driver = this.drivers.get(cwd);
    if (!driver) {
      // jsonl 存储：纯 fs 实现；真实模式与 CLI 共享 ~/.wcode 项目分区
      driver = await createSessionDriver({ storageType: "jsonl", cwd, homeDir: this.homeDir });
      this.drivers.set(cwd, driver);
    }
    return driver;
  }

  private systemFor(cwd: string): string {
    const sections: PromptSection[] = [...defaultPromptSections];
    const persona = this.agents.find((a) => a.name === this.persona);
    if (persona) {
      sections.push({
        id: "persona",
        render: () => `# 助理人设：${persona.name}\n\n${persona.body}`,
      });
    }
    return buildSystemPrompt(sections, { cwd, platform: process.platform });
  }

  private engineFor(): PermissionEngine {
    const rules = this.config
      ? [
          ...this.config.permissions.allow.map((s) => parseRuleString(s, "allow", "config")),
          ...this.config.permissions.deny.map((s) => parseRuleString(s, "deny", "config")),
        ]
      : [];
    return new PermissionEngine({ rules, mode: this.permissionMode });
  }

  private sessionHost(sessionId: string): AgentHost {
    return {
      emit: (ev) => this.host.emit(sessionId, ev),
      requestPermission: (req) => this.host.requestPermission(sessionId, req),
    };
  }

  private async mountSession(
    sessionId: string,
    cwd: string,
    store: SessionStore,
    driver: SessionDriver,
    provider: ModelProvider,
    initialMessages?: Message[],
  ): Promise<AgentSession> {
    const session = new AgentSession({
      provider,
      registry: this.registry,
      host: this.sessionHost(sessionId),
      engine: this.engineFor(),
      system: this.systemFor(cwd),
      cwd,
      store,
      maxContextTokens: this.contextTokens,
      thinking: this.thinkingLevel,
      initialMessages,
    });
    this.sessions.set(sessionId, {
      id: sessionId,
      cwd,
      session,
      store,
      running: false,
      provider,
    });
    return session;
  }

  async createSession(cwd = this.currentCwd): Promise<{ sessionId: string; cwd: string }> {
    this.currentCwd = cwd;
    await this.refreshDiscoveries();
    const driver = await this.driverFor(cwd);
    const created = await driver.createNew({ cwd });
    const provider = this.providerFor(cwd);
    await this.mountSession(created.sessionId, cwd, created.store, driver, provider);
    this.opts.cb.onInfo();
    return { sessionId: created.sessionId, cwd };
  }

  /** 打开历史会话：惰性挂为活会话（resume 语义），返回重放消息 */
  async openSession(
    cwd: string,
    sessionId: string,
  ): Promise<{ sessionId: string; messages: Message[] }> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return { sessionId, messages: messagesFromSessionLines(await existing.store.load()) };
    }
    const driver = await this.driverFor(cwd);
    const store = await driver.open(sessionId);
    const messages = messagesFromSessionLines(await store.load());
    const provider = this.providerFor(cwd);
    await this.mountSession(sessionId, cwd, store, driver, provider, messages);
    return { sessionId, messages };
  }

  /** 检查点分叉：原会话不动，第 userTurn 个用户轮次（0 起）之前的历史复制为新会话 */
  async forkSession(
    cwd: string,
    sessionId: string,
    userTurn: number,
  ): Promise<{ sessionId: string; messages: Message[] }> {
    const source = await (await this.driverFor(cwd)).open(sessionId);
    const messages = messagesFromSessionLines(await source.load());
    let keep = messages.length;
    let seen = -1;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m && m.role === "user") {
        seen++;
        if (seen === userTurn) {
          keep = i;
          break;
        }
      }
    }
    const kept = messages.slice(0, keep);
    const driver = await this.driverFor(cwd);
    const created = await driver.createNew({ cwd });
    for (const m of kept) {
      await created.store.append({ v: 1, type: "message", message: m });
    }
    const provider = this.providerFor(cwd);
    await this.mountSession(created.sessionId, cwd, created.store, driver, provider, kept);
    this.opts.cb.onInfo();
    return { sessionId: created.sessionId, messages: kept };
  }

  /** 检查点原地回退：截断标记落盘（jsonl 旧数据保留），会话 id 不变 */
  async rollbackSession(
    cwd: string,
    sessionId: string,
    userTurn: number,
  ): Promise<{ sessionId: string; messages: Message[] }> {
    const desk = this.sessions.get(sessionId);
    if (desk?.running) throw new Error("会话正在运行，请先停止再回退");
    const driver = await this.driverFor(cwd);
    const store = await driver.open(sessionId);
    const messages = messagesFromSessionLines(await store.load());
    let keep = messages.length;
    let seen = -1;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m && m.role === "user") {
        seen++;
        if (seen === userTurn) {
          keep = i;
          break;
        }
      }
    }
    const kept = messages.slice(0, keep);
    await store.append({ v: 1, type: "truncate", keepMessages: keep, at: new Date().toISOString() });
    // 已挂载 → 原地替换历史；未挂载 → 挂为活会话（保证下一次 send 可达）
    if (desk) {
      desk.session.applyResume(store, kept);
    } else {
      await this.mountSession(sessionId, cwd, store, driver, this.providerFor(cwd), kept);
    }
    this.opts.cb.onInfo();
    return { sessionId, messages: kept };
  }

  /** 删除会话：运行中拒绝；活会话卸载，磁盘存储连消息一起清除 */
  async deleteSession(cwd: string, sessionId: string): Promise<void> {
    const desk = this.sessions.get(sessionId);
    if (desk?.running) throw new Error("会话正在运行，请先停止再删除");
    if (desk) this.sessions.delete(sessionId);
    const driver = await this.driverFor(cwd);
    await driver.delete(sessionId);
    this.opts.cb.onInfo();
  }

  async runTurn(sessionId: string, text: string): Promise<void> {
    const desk = this.sessions.get(sessionId);
    if (!desk || desk.running || text.trim() === "") return;
    desk.running = true;
    this.opts.cb.onInfo();
    try {
      await desk.session.run(text);
    } catch (err) {
      // run() 抛出即无 done 事件，补两条让渲染层复位
      this.host.emit(sessionId, { type: "error", message: errorMessage(err) });
      this.host.emit(sessionId, { type: "done", reason: "aborted" });
    } finally {
      desk.running = false;
      this.opts.cb.onInfo();
    }
  }

  abort(sessionId: string): void {
    this.sessions.get(sessionId)?.session.abort();
  }

  decide(askId: string, decision: PermissionDecision): void {
    this.host.resolve(askId, decision);
  }

  async search(keyword: string): Promise<SearchHitEntry[]> {
    const hits: SearchHitEntry[] = [];
    for (const [cwd, driver] of this.drivers) {
      const found = await driver.search(keyword, 10).catch(() => []);
      for (const h of found) {
        hits.push({
          sessionId: h.sessionId,
          cwd,
          messageIndex: h.messageIndex,
          role: h.role,
          excerpt: h.excerpt,
        });
      }
    }
    return hits.slice(0, 30);
  }

  async listModels(): Promise<string[]> {
    if (this.mode === "demo") return DEMO_MODELS;
    try {
      const models = await this.providerFor(this.currentCwd).listModels?.();
      if (models && models.length > 0) return models;
    } catch {
      // 网关不支持列表时降级为当前模型
    }
    return this.config?.model ? [this.config.model] : [];
  }

  /** 模型热切：真实模式重建 provider 并换入空闲会话（运行中的会话保持不动） */
  setModel(model: string): void {
    this.model = model;
    if (this.mode === "real") {
      try {
        this.realProvider = this.buildRealProvider(model);
        for (const desk of this.sessions.values()) {
          if (!desk.running) {
            desk.session.setProvider(this.realProvider);
            desk.provider = this.realProvider;
          }
        }
      } catch (err) {
        this.notice = `模型切换失败（${errorMessage(err)}）`;
      }
    }
    this.opts.cb.onInfo();
  }

  /** 以下两项对新会话生效（会话创建时装配） */
  setContextTokens(tokens: number): void {
    this.contextTokens = tokens;
    this.opts.cb.onInfo();
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    this.opts.cb.onInfo();
  }

  /** 思考级别即时生效：下一轮请求就带新预算（AgentSession 内是纯请求字段，运行中也安全） */
  setThinkingLevel(level: ThinkingLevel): void {
    this.thinkingLevel = level;
    for (const desk of this.sessions.values()) {
      desk.session.setThinkingLevel(level);
    }
    this.opts.cb.onInfo();
  }

  setPersona(name: string | null): void {
    this.persona = name;
    this.opts.cb.onInfo();
  }

  /** 启用立即连接（共享注册表，进行中的会话下一次请求即生效）；停用对新会话生效 */
  async setMcpEnabled(name: string, enabled: boolean): Promise<void> {
    const servers = this.config?.mcpServers ?? {};
    const cfg: McpServerConfig | undefined = servers[name];
    if (enabled) {
      this.mcpDisabled.delete(name);
      if (cfg && !this.mcpConnected.has(name)) {
        try {
          await this.registry.registerSource(await createMcpToolSource(name, cfg));
          this.mcpConnected.add(name);
        } catch (err) {
          this.mcpProblems.push(`MCP ${name}: ${errorMessage(err)}`);
        }
      }
    } else {
      this.mcpDisabled.add(name);
      this.mcpConnected.delete(name);
      await this.rebuildRegistry();
    }
    this.opts.cb.onInfo();
  }

  /** 新增 MCP 服务器：写入用户级 settings → 重载配置 → 立即连接 */
  async addMcpServer(
    name: string,
    command: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<void> {
    const key = name.trim();
    if (!key) throw new Error("请填写服务器名称");
    if (!command.trim()) throw new Error("请填写启动命令");
    await patchUserSettings((obj) => {
      const servers = (obj.mcpServers as Record<string, unknown> | undefined) ?? {};
      if (key in servers) throw new Error(`用户级配置中已存在 MCP 服务器「${key}」`);
      servers[key] = {
        command: command.trim(),
        args: args.filter((a) => a.trim() !== ""),
        ...(env && Object.keys(env).length > 0 ? { env } : {}),
      };
      obj.mcpServers = servers;
    }, this.homeDir);
    await this.reloadConfig();
    const cfg = this.config?.mcpServers?.[key];
    if (cfg) {
      try {
        await this.registry.registerSource(await createMcpToolSource(key, cfg));
        this.mcpConnected.add(key);
        this.notice = `MCP ${key} 已连接`;
      } catch (err) {
        this.mcpProblems.push(`MCP ${key}: ${errorMessage(err)}`);
        this.notice = `MCP ${key} 已保存，但连接失败：${errorMessage(err)}`;
      }
    }
    this.opts.cb.onInfo();
  }

  /** 删除 MCP 服务器：只允许删用户级条目；项目级配置提示去编辑项目文件 */
  async removeMcpServer(name: string): Promise<void> {
    await patchUserSettings((obj) => {
      const servers = (obj.mcpServers as Record<string, unknown> | undefined) ?? {};
      if (!(name in servers)) {
        throw new Error(
          `「${name}」不在用户级 ~/.wcode/settings.json 中（可能来自项目级 .wcode/settings.json），请编辑对应配置文件删除`,
        );
      }
      delete servers[name];
      obj.mcpServers = servers;
    }, this.homeDir);
    this.mcpDisabled.delete(name);
    this.mcpConnected.delete(name);
    await this.reloadConfig();
    await this.rebuildRegistry();
    this.notice = `MCP ${name} 已删除`;
    this.opts.cb.onInfo();
  }

  async saveProviderKey(name: string, key: string): Promise<void> {
    await patchUserSettings((obj) => {
      const providers = (obj.providers as Record<string, Record<string, unknown>> | undefined) ?? {};
      const entry = (providers[name] as Record<string, unknown> | undefined) ?? {};
      entry.apiKey = key;
      providers[name] = entry;
      obj.providers = providers;
    }, this.homeDir);
    await this.reloadConfig();
    if (this.mode === "demo") {
      this.notice = "API key 已保存。重启应用后自动进入真实模型模式。";
    } else {
      this.notice = "API key 已保存并即时生效。";
      this.rebuildRealProvider();
    }
    this.opts.cb.onInfo();
  }

  async setActiveProvider(name: string): Promise<void> {
    await patchUserSettings((obj) => {
      obj.activeProvider = name;
    }, this.homeDir);
    await this.reloadConfig();
    if (this.mode === "real") {
      const cfg = this.config?.providers[name];
      const key = cfg?.apiKey ?? (cfg ? (process.env[cfg.apiKeyEnv] ?? "") : "");
      if (key) {
        this.apiKey = key;
        this.rebuildRealProvider();
        this.notice = `已切换服务商：${name}`;
      } else {
        this.notice = `已切换到 ${name}，但该服务商缺少 API key。`;
      }
    } else {
      this.notice = "已保存。重启应用后以新服务商运行。";
    }
    this.opts.cb.onInfo();
  }

  private rebuildRealProvider(): void {
    if (this.mode !== "real" || !this.config) return;
    try {
      this.realProvider = this.buildRealProvider(this.model);
      for (const desk of this.sessions.values()) {
        if (!desk.running) desk.session.setProvider(this.realProvider);
      }
    } catch (err) {
      this.notice = `服务商重建失败（${errorMessage(err)}）`;
    }
  }

  private async reloadConfig(): Promise<void> {
    try {
      this.config = await loadConfig({ overrides: {}, cwd: this.currentCwd, homeDir: path.join(this.homeDir, ".wcode") });
      const cfg = this.config.providers[this.activeProviderName()];
      const key = cfg?.apiKey ?? (cfg ? (process.env[cfg.apiKeyEnv] ?? "") : "");
      if (this.mode === "real" && cfg && key) this.apiKey = key;
    } catch (err) {
      this.notice = `配置重载失败（${errorMessage(err)}）`;
    }
  }

  private fmtTime(iso: string | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  async info(): Promise<RuntimeInfo> {
    const projects: RuntimeInfo["projects"] = [];
    const orderedCwds = [
      this.currentCwd,
      ...[...this.drivers.keys()].filter((c) => c !== this.currentCwd),
    ];
    for (const cwd of orderedCwds) {
      const driver = await this.driverFor(cwd);
      const recent = await driver.listRecent(30).catch(() => []);
      const sessions: SessionEntry[] = recent.map((s) => ({
        id: s.sessionId,
        title: s.preview || "(空会话)",
        time: this.fmtTime(s.createdAt),
        messageCount: s.messageCount,
      }));
      projects.push({
        cwd,
        label: path.basename(cwd) || cwd,
        current: cwd === this.currentCwd,
        sessions,
      });
    }
    const stats = await (await this.driverFor(this.currentCwd)).stats().catch(() => null);
    return {
      mode: this.mode,
      providerName: this.mode === "demo" ? "演示脚本" : this.activeProviderName(),
      model: this.model,
      contextTokens: this.contextTokens,
      permissionMode: this.permissionMode,
      thinkingLevel: this.thinkingLevel,
      persona: this.persona,
      currentCwd: this.currentCwd,
      projects,
      agents: this.agents.map((a) => ({
        name: a.name,
        description: a.description,
        source: a.source,
      })),
      skills: this.skills.map((s) => ({
        name: s.name,
        description: s.description,
        source: s.source,
      })),
      mcpServers: Object.entries(this.config?.mcpServers ?? {}).map(([name, cfg]) => ({
        name,
        command: cfg.command,
        connected: this.mcpConnected.has(name) && !this.mcpDisabled.has(name),
      })),
      providers: Object.entries(this.config?.providers ?? {}).map(([name, cfg]) => ({
        name,
        type: cfg.type,
        hasKey: Boolean(cfg.apiKey) || Boolean(process.env[cfg.apiKeyEnv]),
        active: name === this.activeProviderName(),
      })),
      stats: stats ?? { sessionCount: 0, messageCount: 0, inputTokens: 0, outputTokens: 0 },
      pricing: this.pricingInfo(),
      notice: [this.notice, ...this.mcpProblems].filter(Boolean).join("；") || undefined,
    };
  }

  /** 激活服务商的计价比价（settings.json priceInput/priceOutput）；未配置返回 undefined */
  private pricingInfo(): RuntimeInfo["pricing"] {
    const cfg = this.config?.providers[this.activeProviderName()];
    if (!cfg?.priceInput || !cfg?.priceOutput) return undefined;
    return {
      inputPerMillion: cfg.priceInput,
      outputPerMillion: cfg.priceOutput,
      currency: cfg.priceCurrency ?? "元",
    };
  }
}
