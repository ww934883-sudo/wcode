import { z } from "zod";
import type { HookDef, HooksConfig } from "../config/schema";

/**
 * 插件 hooks/hooks.json（对齐 zcode 格式）：事件名 PascalCase，每个事件是
 * matcher 组数组，组内 hooks 为具体执行项：
 *   { "PreToolUse": [ { "matcher": "Bash", "hooks": [
 *       { "type": "command", "command": "...", "timeout": 30 } ] } ] }
 * type: command = shell 字符串；process = argv 数组（拼接为可执行的 shell 串）。
 */
const hookEntrySchema = z.object({
  type: z.enum(["command", "process"]).default("command"),
  /** command 类型 = shell 串；process 类型 = argv 数组 */
  command: z.union([z.string().min(1), z.array(z.string()).min(1)]),
  /** 秒（zcode 约定）；转换为 wcode 的毫秒 per-def timeout */
  timeout: z.number().positive().optional(),
  statusMessage: z.string().optional(),
  async: z.boolean().optional(),
});

const matcherGroupSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(hookEntrySchema).min(1),
});

export const hooksFileSchema = z.record(z.string(), z.array(matcherGroupSchema));

/** hooks.json 事件名 → wcode HooksConfig 键 */
const EVENT_MAP: Record<string, keyof Omit<HooksConfig, "timeoutMs">> = {
  SessionStart: "sessionStart",
  UserPromptSubmit: "userPromptSubmit",
  PreToolUse: "preToolUse",
  PermissionRequest: "permissionRequest",
  PostToolUse: "postToolUse",
  PostToolUseFailure: "postToolUseFailure",
  Stop: "stop",
};

/** argv → shell 串：含空白/引号的参数用双引号包裹（Windows 优先，cmd/PowerShell 通用） */
export function argvToShellCommand(argv: string[]): string {
  return argv
    .map((a) => (/[\s"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a))
    .join(" ");
}

export interface HooksFileResult {
  /** 可直接并入 HooksConfig 的事件数组（仅出现的事件有值） */
  events: Partial<Omit<HooksConfig, "timeoutMs">>;
  problems: string[];
}

/** hooks.json → wcode HookDef 集合；未知事件/非法组降级为 problem，不阻塞其余条目 */
export function parseHooksFile(json: unknown, label: string): HooksFileResult {
  const parsed = hooksFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? issue.path.join(".") || "(根)" : "?";
    return {
      events: {},
      problems: [`${label} 不合法：字段 ${where} ${issue?.message ?? "校验失败"}，整个文件已跳过`],
    };
  }
  const events: Partial<Omit<HooksConfig, "timeoutMs">> = {};
  const problems: string[] = [];
  for (const [eventName, groups] of Object.entries(parsed.data)) {
    const target = EVENT_MAP[eventName];
    if (!target) {
      problems.push(
        `${label} 含不支持的事件 "${eventName}"（支持：${Object.keys(EVENT_MAP).join("、")}），该事件已跳过`,
      );
      continue;
    }
    const defs: HookDef[] = [];
    for (const group of groups) {
      for (const entry of group.hooks) {
        defs.push({
          matcher: group.matcher,
          command:
            entry.type === "process" && Array.isArray(entry.command)
              ? argvToShellCommand(entry.command)
              : (entry.command as string),
          ...(entry.timeout ? { timeoutMs: Math.round(entry.timeout * 1000) } : {}),
        });
      }
    }
    if (defs.length > 0) {
      events[target] = [...(events[target] ?? []), ...defs];
    }
  }
  return { events, problems };
}
