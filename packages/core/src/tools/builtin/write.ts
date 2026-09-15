import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "../tool";
import { writeFileAtomic } from "../../fs/atomic";
import { contentHash } from "../../session/state";
import { normalizeKey } from "./read";

const WriteSchema = z.object({
  file_path: z.string().min(1).describe("目标文件路径（绝对路径或相对工作目录）"),
  content: z.string().describe("完整文件内容（整文件覆盖写入）"),
});

export const writeTool = defineTool({
  name: "write",
  description:
    "将完整内容写入文件（整文件覆盖）。写入前必须先用 read 工具读取已存在的文件，" +
    "禁止盲写覆盖。写临时文件后原子替换，中断不会留下半截文件。",
  schema: WriteSchema,
  isReadOnly: false,
  rulePatterns: (input) => [`write(${input.file_path})`],
  execute: async (input, ctx) => {
    const abs = isAbsolute(input.file_path)
      ? input.file_path
      : resolve(ctx.session.cwd, input.file_path);

    let exists = false;
    try {
      const st = await stat(abs);
      exists = st.isFile();
      if (st.isDirectory()) {
        return { content: `路径是目录，无法写入: ${abs}` };
      }
    } catch {
      exists = false;
    }

    if (exists && !ctx.session.filesRead.has(normalizeKey(abs))) {
      return {
        content:
          `目标文件已存在且本会话尚未读取过: ${abs}。` +
          "为避免覆盖未知改动，请先调用 read 工具查看内容，再执行写入。",
      };
    }

    await writeFileAtomic(abs, input.content);
    ctx.session.filesRead.set(normalizeKey(abs), contentHash(input.content));
    // 行数统计与 read 工具一致：尾部单个换行是 EOF 标志，不计一行
    const parts = input.content.split("\n");
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    return {
      content: `已写入 ${abs}（${parts.length} 行，${Buffer.byteLength(input.content, "utf8")} 字节）`,
    };
  },
});
