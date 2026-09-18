import type { AgentEvent, Message, ModelCatalogGroup, PermissionDecision, ThinkingLevel } from "@wcode/core";

// 思考级别类型以 core 的 ModelRequest.thinking 为准（provider 映射的单一事实源）
export type { ThinkingLevel };
export type { ModelCatalogGroup };

/**
 * 与 core 的 ALL_THINKING_LEVELS 同步维护。渲染层不允许 value-import @wcode/core：
 * core 的 index 会把 node:fs/path 链进浏览器 bundle（vite 构建直接失败），
 * 渲染层对 core 只做 type 导入。
 */
export const ALL_THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high"];

export type PermissionMode = "plan" | "default" | "acceptEdits" | "bypass";

export interface SessionEntry {
  id: string;
  title: string;
  time: string;
  messageCount: number;
  /** 用户置顶（排序时置顶项前置，置顶态跨重启持久） */
  pinned: boolean;
}

/** 按工作目录（=项目）分组的会话列表 */
export interface ProjectEntry {
  cwd: string;
  label: string;
  current: boolean;
  sessions: SessionEntry[];
}

export interface SearchHitEntry {
  sessionId: string;
  cwd: string;
  messageIndex: number;
  role: string;
  excerpt: string;
}

export interface ProviderEntry {
  name: string;
  type: string;
  hasKey: boolean;
  /** 启用状态（false = 设置页灰点，模型列表隐藏该组） */
  enabled: boolean;
  baseUrl: string | null;
  active: boolean;
}

/** 模型连通性测试结果 */
export interface ModelTestResult {
  ok: boolean;
  latencyMs: number;
  sample?: string;
  error?: string;
}

export interface AgentEntry {
  name: string;
  description: string;
  source: string;
}

export interface SkillEntry {
  name: string;
  description: string;
  source: string;
}

export interface McpEntry {
  name: string;
  command: string;
  connected: boolean;
}

/** 自动化任务条目（core AutomationRecord 的渲染层视图） */
export interface AutomationEntry {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  mode: string;
  scheduleKind: "cron" | "once";
  cronExpr: string | null;
  runAt: number | null;
  timeoutMs: number | null;
  maxRuns: number | null;
  runCount: number;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  running: boolean;
  dispatchAttempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 一次自动化运行记录 */
export interface AutomationRunEntry {
  id: string;
  automationId: string;
  trigger: "schedule" | "manual";
  startedAt: number;
  finishedAt: number | null;
  outcome: string | null;
  sessionId: string | null;
  error: string | null;
}

/** 新建自动化表单提交的调度规格（相对时间由渲染层换算成 epoch 毫秒） */
export type AutomationScheduleSpec =
  | { kind: "cron"; expr: string }
  | { kind: "once"; runAt: number };

export interface AutomationSpecInput {
  title: string;
  prompt: string;
  cwd: string;
  mode?: string;
  schedule: AutomationScheduleSpec;
  timeoutMs?: number;
  maxRuns?: number;
}

export interface StatsInfo {
  sessionCount: number;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
}

/** 激活服务商的单价比价（settings.json 的 priceInput/priceOutput，可选） */
export interface PricingInfo {
  inputPerMillion: number;
  outputPerMillion: number;
  /** 计价货币符号，如 "元" / "$"，缺省 "元" */
  currency: string;
}

export interface RuntimeInfo {
  mode: "demo" | "real";
  providerName: string;
  model: string;
  contextTokens: number;
  permissionMode: PermissionMode;
  thinkingLevel: ThinkingLevel;
  /** 当前模型支持的思考档位（provider 声明；未知按全档；空数组 = 不支持） */
  thinkingLevels: ThinkingLevel[];
  /** 当前选中的助理（自定义 Agent），null = 默认 */
  persona: string | null;
  currentCwd: string;
  projects: ProjectEntry[];
  agents: AgentEntry[];
  skills: SkillEntry[];
  mcpServers: McpEntry[];
  providers: ProviderEntry[];
  stats: StatsInfo;
  /** 激活服务商的计价配置；未配置则用量页只显示 token 数 */
  pricing?: PricingInfo;
  notice?: string;
}

export interface PermissionAsk {
  id: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  patterns: string[];
}

/**
 * 渲染层 ↔ 主进程桥（v2）。会话按 sessionId 多路复用（支持分屏），
 * 渲染层永远拿不到 API key 与文件系统。
 */
export interface WcodeBridge {
  info(): Promise<RuntimeInfo>;
  /** 新建会话；cwd 缺省沿用当前项目 */
  newSession(cwd?: string): Promise<{ sessionId: string; cwd: string }>;
  /** 打开历史会话：返回重放消息（渲染层水合成聊天项），同时主进程挂为活会话 */
  openSession(cwd: string, sessionId: string): Promise<{ sessionId: string; messages: Message[] }>;
  /**
   * 检查点分叉：保留第 userTurn 个用户轮次（0 起）之前的历史，复制为新会话
   * （原会话不动），返回新会话 id 与重放消息。
   */
  forkSession(
    cwd: string,
    sessionId: string,
    userTurn: number,
  ): Promise<{ sessionId: string; messages: Message[] }>;
  /**
   * 检查点原地回退：把该会话截断到第 userTurn 个用户轮次（0 起）之前，
   * 会话 id 不变（区别于分叉），返回回退后的重放消息。
   */
  rollbackSession(
    cwd: string,
    sessionId: string,
    userTurn: number,
  ): Promise<{ sessionId: string; messages: Message[] }>;
  /** 删除会话（运行中的会话拒绝；磁盘存储连消息一起清除，不可恢复） */
  deleteSession(cwd: string, sessionId: string): Promise<void>;
  /** 置顶 / 取消置顶会话（写用户级 settings，跨重启持久） */
  setSessionPinned(sessionId: string, pinned: boolean): Promise<void>;
  searchSessions(keyword: string): Promise<SearchHitEntry[]>;
  send(sessionId: string, text: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  /** /compact 手动压缩：把当前会话历史摘要化（运行中拒绝） */
  compactSession(sessionId: string): Promise<void>;
  /** @ 文件引用候选：扫项目目录（浅递归，跳过依赖/构建目录），按 query 过滤 */
  listProjectFiles(cwd: string, query: string, limit?: number): Promise<string[]>;
  decide(sessionId: string, askId: string, decision: PermissionDecision): Promise<void>;
  listModels(): Promise<string[]>;
  /** 供应商模型目录（SQLite provider_models 表）：按供应商分组的配置模型 */
  listModelCatalog(): Promise<ModelCatalogGroup[]>;
  addCatalogModel(provider: string, model: string, contextLabel?: string): Promise<void>;
  removeCatalogModel(provider: string, model: string): Promise<void>;
  updateCatalogModel(
    provider: string,
    model: string,
    patch: { model?: string; contextLabel?: string | null },
  ): Promise<void>;
  /** 选择模型 = 供应商 + 模型一起切（写配置持久化，空闲会话热切换） */
  selectModel(provider: string, model: string): Promise<void>;
  // ── 供应商管理（设置页两栏）──
  addProvider(name: string, opts?: { type?: string; baseUrl?: string }): Promise<void>;
  removeProvider(name: string): Promise<void>;
  updateProvider(name: string, patch: { baseUrl?: string; type?: string }): Promise<void>;
  renameProvider(oldName: string, newName: string): Promise<void>;
  setProviderEnabled(name: string, enabled: boolean): Promise<void>;
  /** 连通性测试：对（供应商, 模型）发一次最小请求 */
  testModel(provider: string, model: string): Promise<ModelTestResult>;
  /** 读取供应商已存的 key（设置页密文回填；仅用户主动查看场景） */
  getProviderKey(name: string): Promise<string>;
  /** 以下三项对新会话生效（模型选择即时热切活会话） */
  setModel(model: string): Promise<void>;
  setContextTokens(tokens: number): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  setPersona(name: string | null): Promise<void>;
  pickFolder(): Promise<string | null>;
  saveProviderKey(name: string, key: string): Promise<void>;
  setActiveProvider(name: string): Promise<void>;
  setMcpEnabled(name: string, enabled: boolean): Promise<void>;
  /** MCP 配置管理：写用户级 settings.json；新增后立即连接 */
  addMcpServer(name: string, command: string, args: string[], env?: Record<string, string>): Promise<void>;
  /** 仅允许删除用户级条目；项目级条目会报可行动错误 */
  removeMcpServer(name: string): Promise<void>;
  /** 自动化任务（主进程内置调度器执行，与 CLI daemon 共库互斥） */
  listAutomations(): Promise<AutomationEntry[]>;
  addAutomation(spec: AutomationSpecInput): Promise<AutomationEntry>;
  removeAutomation(id: string): Promise<void>;
  setAutomationEnabled(id: string, enabled: boolean): Promise<void>;
  /** 手动立即执行一次（后台运行，结果进运行记录） */
  runAutomation(id: string): Promise<void>;
  listAutomationRuns(id: string): Promise<AutomationRunEntry[]>;
  onEvent(cb: (sessionId: string, ev: AgentEvent) => void): () => void;
  onPermission(cb: (ask: PermissionAsk) => void): () => void;
  onInfo(cb: (info: RuntimeInfo) => void): () => void;
}
