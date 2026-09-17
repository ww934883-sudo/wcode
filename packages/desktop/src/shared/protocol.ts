import type { AgentEvent, Message, PermissionDecision, ThinkingLevel } from "@wcode/core";

// 思考级别类型以 core 的 ModelRequest.thinking 为准（provider 映射的单一事实源）
export type { ThinkingLevel };

export type PermissionMode = "plan" | "default" | "acceptEdits" | "bypass";

export interface SessionEntry {
  id: string;
  title: string;
  time: string;
  messageCount: number;
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
  active: boolean;
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

export interface StatsInfo {
  sessionCount: number;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
}

export interface RuntimeInfo {
  mode: "demo" | "real";
  providerName: string;
  model: string;
  contextTokens: number;
  permissionMode: PermissionMode;
  thinkingLevel: ThinkingLevel;
  /** 当前选中的助理（自定义 Agent），null = 默认 */
  persona: string | null;
  currentCwd: string;
  projects: ProjectEntry[];
  agents: AgentEntry[];
  skills: SkillEntry[];
  mcpServers: McpEntry[];
  providers: ProviderEntry[];
  stats: StatsInfo;
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
  searchSessions(keyword: string): Promise<SearchHitEntry[]>;
  send(sessionId: string, text: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  decide(sessionId: string, askId: string, decision: PermissionDecision): Promise<void>;
  listModels(): Promise<string[]>;
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
  onEvent(cb: (sessionId: string, ev: AgentEvent) => void): () => void;
  onPermission(cb: (ask: PermissionAsk) => void): () => void;
  onInfo(cb: (info: RuntimeInfo) => void): () => void;
}
