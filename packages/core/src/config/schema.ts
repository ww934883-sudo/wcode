import { z } from "zod";

export const permissionModeSchema = z.enum([
  "plan",
  "default",
  "acceptEdits",
  "bypass",
]);

/** lifecycle hook 定义：command 从 stdin 收 JSON payload（hooks/hooks.ts） */
export const hookDefSchema = z.object({
  /** 工具名过滤（正则字符串，如 "write|edit"）；缺省匹配全部。仅工具类事件有效 */
  matcher: z.string().optional(),
  command: z.string().min(1),
  /** 单条 hook 超时（毫秒）；缺省用 hooks.timeoutMs（插件 hooks.json 的秒级 timeout 转换而来） */
  timeoutMs: z.number().int().positive().optional(),
});

/** 七个生命周期事件（键为 camelCase；对齐 zcode 插件 hooks.json 的 PascalCase 事件） */
export const hooksSchema = z.object({
  /** 单个 hook 进程的缺省超时 */
  timeoutMs: z.number().int().positive().default(30_000),
  sessionStart: z.array(hookDefSchema).default([]),
  userPromptSubmit: z.array(hookDefSchema).default([]),
  preToolUse: z.array(hookDefSchema).default([]),
  permissionRequest: z.array(hookDefSchema).default([]),
  postToolUse: z.array(hookDefSchema).default([]),
  postToolUseFailure: z.array(hookDefSchema).default([]),
  stop: z.array(hookDefSchema).default([]),
});

export type HooksConfig = z.infer<typeof hooksSchema>;
export type HookDef = z.infer<typeof hookDefSchema>;

/** 单个 MCP 服务器声明（settings.json 的 mcpServers 与插件 .mcp.json 共用） */
export const mcpServerSpecSchema = z
  .object({
    type: z.enum(["stdio", "http", "sse"]).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .refine((v) => Boolean(v.command || v.url), {
    message: "需要 command（stdio）或 url（http/sse）之一",
  });

export type McpServerSpec = z.infer<typeof mcpServerSpecSchema>;

export const configSchema = z.object({
  /** 当前激活的 provider 键（providers 的 key） */
  activeProvider: z.string().default("anthropic"),
  model: z.string().default("claude-sonnet-4-5"),
  providers: z
    .record(
      z.string(),
      z.object({
        /** anthropic=Messages 协议；openai-compatible=Chat Completions（DeepSeek/Qwen/GLM/Kimi 等）；
         * openai-responses=OpenAI Responses API */
        type: z.enum(["anthropic", "openai-compatible", "openai-responses"]),
        /** 只存环境变量名，不存密钥明文（安全基线 §4.7） */
        apiKeyEnv: z.string().default("ANTHROPIC_API_KEY"),
        /**
         * 明文密钥：仅供用户级 ~/.wcode/settings.json 使用（该文件在仓库外）。
         * 项目级可提交配置一律用 apiKeyEnv。两者同时存在时 apiKey 优先。
         */
        apiKey: z.string().optional(),
        baseUrl: z.string().optional(),
        /** 成本统计（可选）：单价比价，单位 = priceCurrency（缺省"元"）/ 每百万 tokens */
        priceInput: z.number().optional(),
        priceOutput: z.number().optional(),
        priceCurrency: z.string().optional(),
        /** 启用状态（桌面端设置页）：false = 侧栏灰点，模型列表不展示该组 */
        enabled: z.boolean().default(true),
      }),
    )
    .default({
      anthropic: { type: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
    }),
  permissions: z
    .object({
      mode: permissionModeSchema.default("default"),
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .default({ mode: "default", allow: [], deny: [] }),
  tools: z
    .object({
      bashTimeoutMs: z.number().int().positive().default(120_000),
      maxOutputChars: z.number().int().positive().default(30_000),
      backup: z.boolean().default(false),
    })
    .default({ bashTimeoutMs: 120_000, maxOutputChars: 30_000, backup: false }),
  context: z
    .object({
      compactThreshold: z.number().min(0.3).max(0.95).default(0.8),
      maxContextTokens: z.number().int().positive().default(200_000),
    })
    .default({ compactThreshold: 0.8, maxContextTokens: 200_000 }),
  log: z
    .object({
      level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    })
    .default({ level: "info" }),
  /** MCP servers（架构文档 §11）：连接失败降级跳过，不阻塞启动。
   * stdio（command）与 http/sse（url）二选一；有 command 默认 stdio，有 url 默认 http */
  mcpServers: z
    .record(z.string(), mcpServerSpecSchema)
    .default({}),
  /** lifecycle hooks（M2，事件对齐 zcode 插件）：见 hooksSchema */
  hooks: hooksSchema.default({}),
  /** 插件启停标记：键 = `插件名@市场id`；缺省 = 安装即启用 */
  plugins: z
    .object({
      enabled: z.record(z.string(), z.boolean()).default({}),
      /** 被卸载的内置插件名单：卸载过的内置插件不随应用升级装回（对齐 zcode 屏蔽标记） */
      blockedBuiltins: z.array(z.string()).default([]),
    })
    .default({}),
  /** 桌面端置顶的会话 id（会话 id 全局唯一，跨项目平铺） */
  pinnedSessions: z.array(z.string()).default([]),
  /**
   * 会话存储驱动（设计 §6）：sqlite = 单库 ~/.wcode/wcode.db（默认，要求 Node ≥ 24）；
   * jsonl = 旧目录扫描行为（老 Node / 求稳回退）。
   */
  storage: z
    .object({
      type: z.enum(["sqlite", "jsonl"]).default("sqlite"),
    })
    .default({ type: "sqlite" }),
});

export type WcodeConfig = z.infer<typeof configSchema>;
