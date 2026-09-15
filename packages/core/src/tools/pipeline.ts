import type { ToolCall, ToolResultBlock } from "../types";
import type { AgentHost } from "../host/port";
import type { PermissionEngine } from "../permission/engine";
import { extractRuleArg, type Rule } from "../permission/rules";
import { isAbortedError, errorMessage } from "../errors";
import type { Logger } from "../logging/port";
import { truncateOutput } from "./truncate";
import type { ToolContext } from "./tool";
import type { ToolRegistry } from "./registry";

/** M2 Hooks：返回 block=true 阻断本次工具调用（exit-2 语义） */
export type HookFn = (info: {
  toolName: string;
  input: unknown;
  /** 会话中断信号：hook 执行期间用户中止时尽快退出 */
  signal?: AbortSignal;
}) => Promise<{ block: boolean; reason?: string } | void>;

export interface ToolExecutorOptions {
  host: AgentHost;
  engine: PermissionEngine;
  log: Logger;
  maxOutputChars: number;
  hookPre?: HookFn;
  hookPost?: HookFn;
}

/**
 * 工具执行管道（架构文档 §2.7）：
 *   hookPre → 权限 → schema 校验 → 执行 → 截断 → hookPost → 审计
 * 管道永不向 loop 抛业务错误（一律转为 isError 结果）；
 * 唯一例外是 AbortedError，必须穿透。
 */
export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly opts: ToolExecutorOptions,
  ) {}

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResultBlock> {
    const startedAt = Date.now();
    const fail = (content: string): ToolResultBlock => ({
      callId: call.id,
      content,
      isError: true,
    });

    try {
      const tool = this.registry.get(call.name);
      if (!tool) {
        return fail(
          `未知工具 "${call.name}"。可用工具: ${this.registry.names().join(", ")}`,
        );
      }

      if (this.opts.hookPre) {
        const hooked = await this.opts.hookPre({
          toolName: call.name,
          input: call.input,
          signal: ctx?.signal,
        });
        if (hooked?.block) {
          return fail(`被 PreToolUse Hook 阻断: ${hooked.reason ?? "无理由"}`);
        }
      }

      // schema 校验：错误信息要「教学式」，模型据此自纠
      const parsed = tool.schema.safeParse(call.input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue ? issue.path.join(".") || "(根)" : "?";
        return fail(
          `工具 ${call.name} 参数不合法：字段 ${where} ${issue?.message ?? "校验失败"}。` +
            `请核对工具定义后修正参数重试。`,
        );
      }

      // 权限判定
      const patterns = tool.rulePatterns(parsed.data);
      const verdict = this.opts.engine.evaluate({
        toolName: call.name,
        isReadOnly: tool.isReadOnly,
        patterns,
      });
      let allowed = false;
      if (verdict.decision === "allow") {
        allowed = true;
      } else if (verdict.decision === "deny") {
        return fail(`操作被拒绝（${verdict.reason}）。请勿重复尝试，可向用户说明需求。`);
      } else {
        const decision = await this.opts.host.requestPermission({
          toolName: call.name,
          input: parsed.data,
          patterns,
        });
        if (decision === "allowAlways") {
          const first = patterns[0];
          const rule: Rule = {
            tool: call.name,
            pattern: first !== undefined ? extractRuleArg(first) : undefined,
            action: "allow",
            source: "session",
          };
          this.opts.engine.addSessionRule(rule);
          allowed = true;
        } else if (decision === "allow") {
          allowed = true;
        } else {
          return fail(
            "用户拒绝了此操作。请勿重复尝试相同操作，可向用户说明需求或改用其他方案。",
          );
        }
      }
      if (!allowed) return fail("操作未获授权。");

      if (ctx?.signal?.aborted) throw new AbortedSignalError();

      const out = await tool.execute(parsed.data, ctx);
      const { text, truncated } = truncateOutput(out.content, this.opts.maxOutputChars);

      this.opts.log.info("tool.executed", {
        tool: call.name,
        durationMs: Date.now() - startedAt,
        truncated,
        ok: true,
      });
      this.emitEnd(call, true, text, startedAt);
      if (this.opts.hookPost) {
        await this.opts.hookPost({
          toolName: call.name,
          input: parsed.data,
          signal: ctx?.signal,
        });
      }
      return {
        callId: call.id,
        content: text,
        isError: false,
        ...(out.images && out.images.length > 0 ? { images: out.images } : {}),
      };
    } catch (err) {
      if (isAbortedError(err) || err instanceof AbortedSignalError) throw err;
      const msg = `工具 ${call.name} 执行失败: ${errorMessage(err)}`;
      this.opts.log.warn("tool.failed", {
        tool: call.name,
        durationMs: Date.now() - startedAt,
        error: msg,
      });
      this.emitEnd(call, false, msg, startedAt);
      return fail(msg);
    }
  }

  private emitEnd(
    call: ToolCall,
    ok: boolean,
    content: string,
    startedAt: number,
  ): void {
    const firstLine = content.split("\n", 1)[0] ?? "";
    this.opts.host.emit({
      type: "tool_end",
      callId: call.id,
      toolName: call.name,
      ok,
      summary: firstLine.length > 120 ? firstLine.slice(0, 117) + "..." : firstLine,
      durationMs: Date.now() - startedAt,
    });
  }
}

class AbortedSignalError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}
