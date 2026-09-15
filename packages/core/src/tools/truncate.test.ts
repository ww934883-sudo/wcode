import { describe, expect, it } from "vitest";
import { truncateOutput } from "./truncate";

describe("truncateOutput", () => {
  it("不超限原样返回", () => {
    const r = truncateOutput("hello", 100);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe("hello");
  });

  it("超限保留头尾并附提示", () => {
    const text = "A".repeat(1000) + "MIDDLE" + "B".repeat(1000);
    const r = truncateOutput(text, 300);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("A")).toBe(true);
    expect(r.text.endsWith("B")).toBe(true);
    expect(r.text).toContain("输出已截断");
    expect(r.text).not.toContain("MIDDLE"); // 中段被截去
  });

  it("省略数量与实际一致", () => {
    const text = "x".repeat(900);
    const r = truncateOutput(text, 300);
    const head = 100, tail = 200;
    const omitted = 900 - head - tail;
    expect(r.text).toContain(`省略 ${omitted} 字符`);
  });
});
