import { z } from "zod";

export const permissionModeSchema = z.enum([
  "plan",
  "default",
  "acceptEdits",
  "bypass",
]);

/** lifecycle hook 定义：command 从 stdin 收 JSON payload（hooks/hooks.ts） */
export const hookDefSchema = z.object({
  /** 工具名过滤（正则字符串，如 "write|edit"）；缺省匹配全部。仅工具事件有效 */
  matcher: z.string().optional(),
  command: z.string().min(1),
});

export const hooksSchema = z.object({
  /** 单个 hook 进程超时 */
  timeoutMs: z.number().int().positive().default(30_000),
  sessionStart: z.array(hookDefSchema).default([]),
  preToolUse: z.array(hookDefSchema).default([]),
  postToolUse: z.array(hookDefSchema).default([]),
});

export type HooksConfig = z.infer<typeof hooksSchema>;
export type HookDef = z.infer<typeof hookDefSchema>;

export const configSchema = z.object({
  /** 当前激活的 provider 键（providers 的 key） */
  activeProvider: z.string().default("anthropic"),
  model: z.string().default("claude-sonnet-4-5"),
  providers: z
    .record(
      z.string(),
      z.object({
        type: z.enum(["anthropic", "openai-compatible"]),
        /** 只存环境变量名，不存密钥明文（安全基线 §4.7） */
        apiKeyEnv: z.string().default("ANTHROPIC_API_KEY"),
        /**
         * 明文密钥：仅供用户级 ~/.wcode/settings.json 使用（该文件在仓库外）。
         * 项目级可提交配置一律用 apiKeyEnv。两者同时存在时 apiKey 优先。
         */
        apiKey: z.string().optional(),
        baseUrl: z.string().optional(),
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
  /** MCP servers（架构文档 §11）：连接失败降级跳过，不阻塞启动 */
  mcpServers: z
    .record(
      z.string(),
      z.object({
        command: z.string(),
        args: z.array(z.string()).default([]),
        env: z.record(z.string(), z.string()).optional(),
      }),
    )
    .default({}),
  /** lifecycle hooks（M2）：见 hooksSchema */
  hooks: hooksSchema.default({ timeoutMs: 30_000, sessionStart: [], preToolUse: [], postToolUse: [] }),
});

export type WcodeConfig = z.infer<typeof configSchema>;
