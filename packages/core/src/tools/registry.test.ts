import { describe, expect, it } from "vitest";
import { ToolRegistry, sourceOf } from "./registry";
import { readTool } from "./builtin/read";

describe("ToolRegistry", () => {
  it("注册与查询", async () => {
    const r = new ToolRegistry();
    await r.registerSource(sourceOf("builtin", [readTool]));
    expect(r.get("read")?.name).toBe("read");
    expect(r.names()).toEqual(["read"]);
  });

  it("同名冲突拒绝注册", async () => {
    const r = new ToolRegistry();
    await r.registerSource(sourceOf("a", [readTool]));
    await expect(r.registerSource(sourceOf("b", [readTool]))).rejects.toThrow(/冲突/);
  });

  it("toDefs 输出 provider 线格式（内联 JSON Schema）", async () => {
    const r = new ToolRegistry();
    await r.registerSource(sourceOf("builtin", [readTool]));
    const defs = r.toDefs();
    expect(defs).toHaveLength(1);
    const def = defs[0]!;
    expect(def.name).toBe("read");
    expect(def.description).toContain("行号");
    expect((def.inputSchema as Record<string, unknown>).type).toBe("object");
    const props = (def.inputSchema as { properties?: Record<string, { type?: string }> })
      .properties;
    expect(props?.file_path?.type).toBe("string");
  });
});
