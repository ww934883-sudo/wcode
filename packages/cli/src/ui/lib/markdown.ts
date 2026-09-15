/**
 * 轻量 markdown 块解析器（纯函数，TUI 渲染用）。
 * 支持：围栏代码块、标题、有序/无序列表、段落；行内：**粗体** 与 `行内码`。
 * 流式安全：每次全量重解析，输入都很小。
 */

export type MdBlock =
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "para"; text: string };

export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] as string;

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).startsWith("```")) {
        codeLines.push(lines[i] as string);
        i++;
      }
      i++; // 跳过收尾 ```
      // 未闭合到文件尾时，最后一行是 split 出的空串，去掉
      if (codeLines.length > 0 && codeLines[codeLines.length - 1] === "") codeLines.pop();
      blocks.push({ kind: "code", lang, lines: codeLines });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: (heading[1] as string).length,
        text: heading[2] ?? "",
      });
      i++;
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i] as string)) {
        items.push((lines[i] as string).replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ kind: "list", ordered: true, items });
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i] as string)) {
        items.push((lines[i] as string).replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "list", ordered: false, items });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    // 段落：收集连续普通行
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      (lines[i] as string).trim() !== "" &&
      !(lines[i] as string).startsWith("```") &&
      !/^#{1,6}\s+/.test(lines[i] as string) &&
      !/^[-*]\s+/.test(lines[i] as string) &&
      !/^\d+\.\s+/.test(lines[i] as string)
    ) {
      paraLines.push(lines[i] as string);
      i++;
    }
    blocks.push({ kind: "para", text: paraLines.join("\n") });
  }

  return blocks;
}

/** 行内 token：**粗体** / `行内码` / 普通文本 */
export type InlineToken =
  | { type: "bold"; text: string }
  | { type: "code"; text: string }
  | { type: "plain"; text: string };

export function tokenizeInline(text: string): InlineToken[] {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .filter((s) => s !== "")
    .map((p) => {
      if (p.startsWith("**") && p.endsWith("**") && p.length > 4) {
        return { type: "bold" as const, text: p.slice(2, -2) };
      }
      if (p.startsWith("`") && p.endsWith("`") && p.length > 2) {
        return { type: "code" as const, text: p.slice(1, -1) };
      }
      return { type: "plain" as const, text: p };
    });
}
