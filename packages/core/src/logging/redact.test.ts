import { describe, expect, it } from "vitest";
import { redactDeep, redactText } from "./redact";

describe("redactText", () => {
  it("屏蔽常见形态的 API key", () => {
    expect(redactText("key is sk-abc123XYZdef456")).toBe("key is [REDACTED]");
  });

  it("屏蔽 key=value 形态（含 .env 行）", () => {
    expect(redactText("ANTHROPIC_API_KEY=sk-abc123XYZ")).toBe(
      "ANTHROPIC_API_KEY=[REDACTED]",
    );
    expect(redactText('db_password: "hunter2secret"')).toBe(
      "db_password: [REDACTED]",
    );
  });

  it("普通文本不受影响", () => {
    expect(redactText("把 src/app.ts 的第 3 行修一下")).toBe(
      "把 src/app.ts 的第 3 行修一下",
    );
  });
});

describe("redactDeep", () => {
  it("递归处理嵌套对象与数组", () => {
    const input = {
      headers: { authorization: "Bearer abc123XYZ456" },
      list: ["ok", "token=xyz123secret"],
      note: "normal",
    };
    const out = redactDeep(input) as Record<string, unknown>;
    const headers = out.headers as Record<string, unknown>;
    expect(headers.authorization).toBe("[REDACTED]");
    const list = out.list as string[];
    expect(list[1]).toBe("token=[REDACTED]");
    expect(list[0]).toBe("ok");
    expect(out.note).toBe("normal");
  });
});
