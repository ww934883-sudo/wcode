import { describe, expect, it } from "vitest";
import { parseMarkdown, tokenizeInline } from "./markdown";
import { buildEditDiff, buildWriteDiff } from "./diff";

describe("parseMarkdown", () => {
  it("标题/列表/段落", () => {
    const blocks = parseMarkdown("# 标题\n\n说明文字。\n- 甲\n- 乙\n\n1. 第一\n2. 第二\n");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "标题" },
      { kind: "para", text: "说明文字。" },
      { kind: "list", ordered: false, items: ["甲", "乙"] },
      { kind: "list", ordered: true, items: ["第一", "第二"] },
    ]);
  });

  it("围栏代码块（含语言与未闭合容错）", () => {
    const blocks = parseMarkdown("```ts\nconst a = 1;\nconst b = 2;\n");
    expect(blocks).toEqual([{ kind: "code", lang: "ts", lines: ["const a = 1;", "const b = 2;"] }]);
  });

  it("流式中间态不崩溃", () => {
    expect(parseMarkdown("```ts\n未闭合")).toEqual([
      { kind: "code", lang: "ts", lines: ["未闭合"] },
    ]);
    expect(parseMarkdown("**粗体")).toEqual([{ kind: "para", text: "**粗体" }]);
  });
});

describe("tokenizeInline", () => {
  it("粗体与行内码", () => {
    expect(tokenizeInline("用 **wcode** 跑 `npm test` 即可")).toEqual([
      { type: "plain", text: "用 " },
      { type: "bold", text: "wcode" },
      { type: "plain", text: " 跑 " },
      { type: "code", text: "npm test" },
      { type: "plain", text: " 即可" },
    ]);
  });

  it("无标记原样返回", () => {
    expect(tokenizeInline("普通文本")).toEqual([{ type: "plain", text: "普通文本" }]);
  });
});

describe("diff 构建", () => {
  const content = "line1\nline2\nline3\nline4\nline5\nline6\nline7\n";

  it("edit：del/add 与上下文", () => {
    const lines = buildEditDiff(content, "line4", "LINE4", "a.txt");
    expect(lines[0]).toEqual({ type: "meta", text: "--- a.txt" });
    expect(lines.some((l) => l.type === "del" && l.text === "line4")).toBe(true);
    expect(lines.some((l) => l.type === "add" && l.text === "LINE4")).toBe(true);
    expect(lines.some((l) => l.type === "ctx" && l.text === "line3")).toBe(true);
    expect(lines.some((l) => l.type === "ctx" && l.text === "line5")).toBe(true);
  });

  it("edit：old_string 不存在时给出提示行", () => {
    const lines = buildEditDiff(content, "nope", "x", "a.txt");
    expect(lines[0]?.type).toBe("meta");
    expect(lines[0]?.text).toContain("未找到");
  });

  it("write：整文件预览带行数上限", () => {
    const lines = buildWriteDiff("a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\nq", "b.txt", 10);
    expect(lines[0]?.text).toContain("整文件写入，共 17 行");
    expect(lines.filter((l) => l.type === "add")).toHaveLength(10);
    expect(lines.at(-1)?.text).toContain("其余 7 行");
  });
});
