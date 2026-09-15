import { describe, expect, it } from "vitest";
import { globToRegExp, parseRuleString } from "./rules";
import { PermissionEngine, type PermissionEvalContext } from "./engine";

function ctx(overrides: Partial<PermissionEvalContext>): PermissionEvalContext {
  return {
    toolName: "write",
    isReadOnly: false,
    patterns: ["write(src/a.ts)"],
    ...overrides,
  };
}

describe("PermissionEngine 优先级与模式", () => {
  it("default 模式：只读放行，变更询问", () => {
    const e = new PermissionEngine();
    expect(e.evaluate(ctx({ toolName: "read", isReadOnly: true, patterns: ["read(a.txt)"] }))).toEqual({ decision: "allow" });
    expect(e.evaluate(ctx({}))).toEqual({ decision: "ask" });
  });

  it("acceptEdits：文件编辑类放行，其他变更类仍询问", () => {
    const e = new PermissionEngine({ mode: "acceptEdits" });
    expect(e.evaluate(ctx({ toolName: "write" }))).toEqual({ decision: "allow" });
    expect(e.evaluate(ctx({ toolName: "bash", patterns: ["bash(git status)"] }))).toEqual({ decision: "ask" });
  });

  it("bypass 全放行；plan 拒绝变更类并给理由", () => {
    expect(new PermissionEngine({ mode: "bypass" }).evaluate(ctx({}))).toEqual({ decision: "allow" });
    const plan = new PermissionEngine({ mode: "plan" });
    const v = plan.evaluate(ctx({}));
    expect(v).toEqual({ decision: "deny", reason: "plan 模式只允许只读操作" });
    expect(plan.evaluate(ctx({ toolName: "read", isReadOnly: true }))).toEqual({ decision: "allow" });
  });

  it("deny 规则压过 allow 规则与会话 allowAlways", () => {
    const e = new PermissionEngine({
      mode: "bypass",
      rules: [
        parseRuleString("write", "deny", "config"),
        parseRuleString("write(src/**)", "allow", "config"),
      ],
    });
    expect(e.evaluate(ctx({})).decision).toBe("deny");
    e.addSessionRule(parseRuleString("write", "allow", "session"));
    expect(e.evaluate(ctx({})).decision).toBe("deny");
  });

  it("config allow 命中后不再询问", () => {
    const e = new PermissionEngine({
      rules: [parseRuleString("write(src/**)", "allow", "config")],
    });
    expect(e.evaluate(ctx({}))).toEqual({ decision: "allow" });
  });

  it("会话 allowAlways 生效", () => {
    const e = new PermissionEngine();
    expect(e.evaluate(ctx({})).decision).toBe("ask");
    e.addSessionRule(parseRuleString("write(src/a.ts)", "allow", "session"));
    expect(e.evaluate(ctx({}))).toEqual({ decision: "allow" });
  });

  it("glob 模式匹配语义：* 不跨目录，** 跨目录", () => {
    const e = new PermissionEngine({
      rules: [parseRuleString("write(src/*.ts)", "allow", "config")],
    });
    expect(e.evaluate(ctx({ patterns: ["write(src/a.ts)"] })).decision).toBe("allow");
    expect(e.evaluate(ctx({ patterns: ["write(src/sub/a.ts)"] })).decision).toBe("ask");
  });

  it("未知工具按写操作处理（default 模式询问）", () => {
    const e = new PermissionEngine();
    expect(
      e.evaluate(ctx({ toolName: "mcp__x__deploy", isReadOnly: false, patterns: ["mcp__x__deploy"] })).decision,
    ).toBe("ask");
  });
});

describe("globToRegExp", () => {
  it("基础语义", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("npm run test*").test("npm run test:unit")).toBe(true);
    expect(globToRegExp("a?c").test("abc")).toBe(true);
    expect(globToRegExp("a.c").test("abc")).toBe(false); // 点号按字面量
  });

  it("parseRuleString 解析", () => {
    expect(parseRuleString("Bash(git *)", "allow", "config")).toEqual({
      tool: "Bash",
      pattern: "git *",
      action: "allow",
      source: "config",
    });
    expect(parseRuleString("read", "deny", "config").pattern).toBeUndefined();
    expect(() => parseRuleString("bad rule (", "allow", "config")).toThrow();
  });
});
