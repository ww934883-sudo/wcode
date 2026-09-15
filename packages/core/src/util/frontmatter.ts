/**
 * Markdown frontmatter 解析（Skills / 自定义子 Agent 共用）。
 * 刻意不引入 YAML 依赖：只支持 `key: value` 简单行，
 * 足够覆盖 name/description/tools 这类元信息。
 */
export interface FrontmatterResult {
  /** frontmatter 键值对（值为单行字符串） */
  data: Record<string, string>;
  /** 正文（closing --- 之后的全部内容，两端 trim） */
  body: string;
}

export function parseFrontmatter(text: string): FrontmatterResult {
  const lines = text.replace(/^\uFEFF/, "").trimStart().split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") {
    return { data: {}, body: text.trim() };
  }
  const data: Record<string, string> = {};
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") {
      closeIndex = i;
      break;
    }
    const sep = line.indexOf(":");
    if (sep <= 0) continue; // 无冒号/空键的行直接跳过（宽松解析）
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key) data[key] = value;
  }
  if (closeIndex === -1) {
    // 没有 closing --- 视为无 frontmatter，避免把正文误当配置
    return { data: {}, body: text.trim() };
  }
  return { data, body: lines.slice(closeIndex + 1).join("\n").trim() };
}
