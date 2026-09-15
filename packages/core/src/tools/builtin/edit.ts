import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "../tool";
import { writeFileAtomic } from "../../fs/atomic";
import { contentHash } from "../../session/state";
import { normalizeKey } from "./read";

const EditSchema = z.object({
  file_path: z.string().min(1).describe("目标文件路径（绝对路径或相对工作目录）"),
  old_string: z
    .string()
    .min(1)
    .describe("要替换的精确原文（含缩进与换行），必须与 read 输出中的内容逐字一致"),
  new_string: z.string().describe("替换后的内容"),
  replace_all: z
    .boolean()
    .optional()
    .describe("为 true 时替换全部匹配；默认要求 old_string 在文件中唯一"),
});

export const editTool = defineTool({
  name: "edit",
  description:
    "对文件做精确字符串替换。编辑前必须先用 read 读取该文件，old_string 必须与文件内容" +
    "逐字一致（含缩进）；匹配多处时会报错，此时请扩大上下文或设置 replace_all。" +
    "新建文件用 write，大批量改动可多次调用本工具。",
  schema: EditSchema,
  isReadOnly: false,
  rulePatterns: (input) => [`edit(${input.file_path})`],
  execute: async (input, ctx) => {
    const abs = isAbsolute(input.file_path)
      ? input.file_path
      : resolve(ctx.session.cwd, input.file_path);
    const key = normalizeKey(abs);

    if (!ctx.session.filesRead.has(key)) {
      return {
        content: `编辑前必须先用 read 工具读取该文件（本会话尚未读取）: ${abs}`,
      };
    }

    let current: string;
    try {
      const st = await stat(abs);
      if (!st.isFile()) return { content: `路径不是文件: ${abs}` };
      current = await readFile(abs, "utf8");
    } catch {
      return { content: `文件不存在或不可读: ${abs}。新建文件请使用 write 工具。` };
    }

    // 过期保护：读取之后文件被外部改动 → 拒绝编辑
    if (ctx.session.filesRead.get(key) !== contentHash(current)) {
      return {
        content:
          `文件在本会话读取后被外部修改过: ${abs}。` +
          "为避免覆盖未知改动，请先重新 read 再执行编辑。",
      };
    }

    const occurrences = current.split(input.old_string).length - 1;
    if (occurrences === 0) {
      return {
        content:
          `old_string 在文件中未找到（0 处匹配）。请对照 read 输出逐字核对，` +
          `注意缩进、行尾与全角/半角差异；必要时用 read 重新获取精确文本。`,
      };
    }
    if (occurrences > 1 && !input.replace_all) {
      return {
        content:
          `old_string 匹配到 ${occurrences} 处，不唯一。` +
          `请扩大上下文（包含更多前后行）使其唯一，或设置 replace_all: true 替换全部。`,
      };
    }

    const updated = input.replace_all
      ? current.split(input.old_string).join(input.new_string)
      : current.replace(input.old_string, input.new_string);

    await writeFileAtomic(abs, updated);
    ctx.session.filesRead.set(key, contentHash(updated));
    const replaced = input.replace_all ? occurrences : 1;
    return {
      content:
        `已编辑 ${abs}（替换 ${replaced} 处，` +
        `${Buffer.byteLength(current, "utf8")} → ${Buffer.byteLength(updated, "utf8")} 字节）`,
    };
  },
});
