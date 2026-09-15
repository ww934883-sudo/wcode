/**
 * 权限确认用的 diff 计算（纯函数，便于单测）。
 * edit → 定位替换区域并给出上下文；write → 新内容预览。
 */

export interface DiffLine {
  type: "meta" | "ctx" | "del" | "add";
  text: string;
}

export function buildEditDiff(
  content: string,
  oldString: string,
  newString: string,
  filePath: string,
  contextLines = 2,
): DiffLine[] {
  const idx = content.indexOf(oldString);
  if (idx < 0) {
    return [{ type: "meta", text: `${filePath}（未找到 old_string，请直接查看参数）` }];
  }
  const before = content.slice(0, idx);
  const after = content.slice(idx + oldString.length);

  const ctxBefore = before.split("\n").filter((l) => l !== "").slice(-contextLines);
  const ctxAfter = after
    .split("\n")
    .filter((l) => l !== "")
    .slice(0, contextLines);

  const lines: DiffLine[] = [{ type: "meta", text: `--- ${filePath}` }];
  for (const l of ctxBefore) lines.push({ type: "ctx", text: l });
  for (const l of oldString.split("\n")) lines.push({ type: "del", text: l });
  for (const l of newString.split("\n")) lines.push({ type: "add", text: l });
  for (const l of ctxAfter) lines.push({ type: "ctx", text: l });
  return lines;
}

export function buildWriteDiff(
  newContent: string,
  filePath: string,
  maxLines = 15,
): DiffLine[] {
  const all = newContent.split("\n");
  const shown = all.slice(0, maxLines);
  const lines: DiffLine[] = [{ type: "meta", text: `--- ${filePath}（整文件写入，共 ${all.length} 行）` }];
  for (const l of shown) lines.push({ type: "add", text: l });
  if (all.length > maxLines) {
    lines.push({ type: "meta", text: `...（其余 ${all.length - maxLines} 行省略）` });
  }
  return lines;
}

export interface DiffSource {
  toolName: string;
  input: unknown;
}

/** 从权限请求构建 diff 预览；读文件失败返回 null（不阻塞询问） */
export async function buildDiffPreview(
  req: DiffSource,
  readFile: (path: string) => Promise<string | null>,
): Promise<DiffLine[] | null> {
  try {
    if (req.toolName === "edit") {
      const input = req.input as {
        file_path?: string;
        old_string?: string;
        new_string?: string;
      };
      if (
        !input.file_path ||
        input.old_string === undefined ||
        input.new_string === undefined
      ) {
        return null;
      }
      const content = await readFile(input.file_path);
      if (content === null) return null;
      return buildEditDiff(content, input.old_string, input.new_string, input.file_path);
    }
    if (req.toolName === "write") {
      const input = req.input as { file_path?: string; content?: string };
      if (!input.file_path || input.content === undefined) return null;
      return buildWriteDiff(input.content, input.file_path);
    }
  } catch {
    return null;
  }
  return null;
}
