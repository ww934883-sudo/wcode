/**
 * 权限规则解析（架构文档 §3.5）：
 *   "Edit"                → 该工具任意输入
 *   "Edit(src/**)"        → 该工具且 rulePatterns 命中 glob
 *   "Bash(git *)"         → 命令串前缀 + glob
 */

export type RuleAction = "allow" | "deny";
export type RuleSource = "config" | "session";

export interface Rule {
  tool: string;
  pattern?: string;
  action: RuleAction;
  source: RuleSource;
}

export function parseRuleString(
  spec: string,
  action: RuleAction,
  source: RuleSource,
): Rule {
  const trimmed = spec.trim();
  const m = /^([A-Za-z_][A-Za-z0-9_-]*)(?:\((.*)\))?$/.exec(trimmed);
  if (!m) {
    throw new Error(`非法权限规则: "${spec}"，期望格式 "Tool" 或 "Tool(pattern)"`);
  }
  const tool = m[1] as string;
  const pattern = m[2];
  return { tool, pattern: pattern && pattern.length > 0 ? pattern : undefined, action, source };
}

export function ruleToString(rule: Rule): string {
  return rule.pattern ? `${rule.tool}(${rule.pattern})` : rule.tool;
}

/** 从候选串剥离 "tool(arg)" 包装，取 arg 部分参与 glob 匹配 */
export function extractRuleArg(candidate: string): string {
  const m = /^[A-Za-z_][A-Za-z0-9_-]*\((.*)\)$/.exec(candidate);
  return m ? (m[1] as string) : candidate;
}

/** 极小 glob 匹配：** 跨目录、* 不跨 /、? 单字符，其余字符按字面量 */
export function globMatch(pattern: string, candidate: string): boolean {
  const re = globToRegExp(pattern);
  return re.test(candidate);
}

export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** 跨目录，吞掉紧随的 /
        out += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += ".";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}
