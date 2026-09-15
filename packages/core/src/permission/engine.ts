import {
  extractRuleArg,
  globMatch,
  type Rule,
} from "./rules";

export type PermissionMode = "plan" | "default" | "acceptEdits" | "bypass";

/** 文件编辑类工具：acceptEdits 模式下自动放行的范围（其余变更类仍需确认） */
const EDIT_TOOLS = new Set(["edit", "write", "notebookedit"]);

export interface PermissionEvalContext {
  toolName: string;
  isReadOnly: boolean;
  /** 如 ["Edit(src/app.ts)"]，供 "Tool(pattern)" 规则匹配 */
  patterns: string[];
}

export type Verdict =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "ask" };

export interface PermissionEngineOptions {
  rules?: Rule[];
  mode?: PermissionMode;
}

/**
 * 权限判定优先级（架构文档 §3.5）：
 *   deny（config+session）> allow（config）> allowAlways（session）> 模式默认值
 * allowAlways 永远不能越过 deny；plan 模式只放行只读。
 */
export class PermissionEngine {
  private readonly configRules: Rule[];
  private readonly sessionRules: Rule[] = [];
  readonly mode: PermissionMode;

  constructor(opts: PermissionEngineOptions = {}) {
    this.configRules = opts.rules ?? [];
    this.mode = opts.mode ?? "default";
  }

  addSessionRule(rule: Rule): void {
    this.sessionRules.push(rule);
  }

  evaluate(ctx: PermissionEvalContext): Verdict {
    const deny = this.matchRule(
      [...this.configRules, ...this.sessionRules],
      "deny",
      ctx,
    );
    if (deny) return { decision: "deny", reason: `命中拒绝规则 ${describe(deny)}` };

    const configAllow = this.matchRule(this.configRules, "allow", ctx);
    if (configAllow) return { decision: "allow" };

    const sessionAllow = this.matchRule(this.sessionRules, "allow", ctx);
    if (sessionAllow) return { decision: "allow" };

    if (this.mode === "bypass") return { decision: "allow" };
    if (this.mode === "plan") {
      return ctx.isReadOnly
        ? { decision: "allow" }
        : { decision: "deny", reason: "plan 模式只允许只读操作" };
    }
    if (ctx.isReadOnly) return { decision: "allow" };
    if (this.mode === "acceptEdits" && EDIT_TOOLS.has(ctx.toolName.toLowerCase())) {
      return { decision: "allow" };
    }
    return { decision: "ask" };
  }

  private matchRule(
    rules: Rule[],
    action: "allow" | "deny",
    ctx: PermissionEvalContext,
  ): Rule | undefined {
    return rules.find(
      (r) =>
        r.action === action &&
        r.tool.toLowerCase() === ctx.toolName.toLowerCase() &&
        (r.pattern === undefined ||
          ctx.patterns.some((p) => {
            // 规则 pattern 描述的是参数部分（如 "src/**"），
            // 候选串可能是 "tool(arg)" 或裸 "arg"，两种形态都试
            const arg = extractRuleArg(p);
            return (
              globMatch(r.pattern as string, arg) ||
              globMatch(r.pattern as string, p)
            );
          })),
    );
  }
}

function describe(rule: Rule): string {
  return rule.pattern ? `${rule.tool}(${rule.pattern})` : rule.tool;
}
