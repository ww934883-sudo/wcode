import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "../tool";
import { contentHash } from "../../session/state";

const MAX_LINES = 2000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** read 支持的图片格式（架构文档 §2.10 多模态） */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const ReadSchema = z.object({
  file_path: z.string().min(1).describe("要读取的文件路径（绝对路径或相对工作目录）"),
  offset: z.number().int().min(1).optional().describe("起始行号（1 起，含）"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LINES)
    .optional()
    .describe(`最多读取行数，默认 ${MAX_LINES}`),
});

export const readTool = defineTool({
  name: "read",
  description:
    "读取文本文件内容，输出带行号（行号 + 制表符 + 内容）。" +
    `大文件自动分页（默认最多 ${MAX_LINES} 行），可用 offset/limit 继续读取。` +
    "在编辑文件前必须先读取，以获得准确的文本。",
  schema: ReadSchema,
  isReadOnly: true,
  rulePatterns: (input) => [`read(${input.file_path})`],
  execute: async (input, ctx) => {
    const abs = isAbsolute(input.file_path)
      ? input.file_path
      : resolve(ctx.session.cwd, input.file_path);

    let st;
    try {
      st = await stat(abs);
    } catch {
      return { content: `文件不存在: ${abs}。请检查路径（注意大小写）后重试。` };
    }
    if (st.isDirectory()) {
      return { content: `路径是目录而非文件: ${abs}。请改用 glob 工具列出文件。` };
    }

    // 图片：base64 作为图像块返回（模型需支持视觉；不支持时由 provider/UI 降级提示）
    const mediaType = IMAGE_MEDIA_TYPES[extname(abs).toLowerCase()];
    if (mediaType) {
      if (st.size > MAX_IMAGE_BYTES) {
        return {
          content: `图片过大（${st.size} 字节 > ${MAX_IMAGE_BYTES}），不读取: ${abs}`,
        };
      }
      const buf = await readFile(abs);
      const data = buf.toString("base64");
      ctx.session.filesRead.set(normalizeKey(abs), contentHash(data));
      return {
        content: `[图片文件: ${abs}，${buf.byteLength} 字节，已作为图像内容返回]`,
        images: [{ type: "image", mediaType, data }],
      };
    }

    let raw: string;
    try {
      raw = await readFile(abs, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return { content: `读取失败(${code}): ${abs}` };
    }
    if (raw.includes("\0")) {
      return { content: `疑似二进制文件，不显示内容: ${abs}` };
    }

    // 记录已读哈希，供 write 的「禁止盲写覆盖」保护使用
    ctx.session.filesRead.set(normalizeKey(abs), contentHash(raw));

    const lines = raw.split("\n");
    // 尾部单个空行是文件结尾标志，不计入行数
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const total = lines.length;
    if (total === 0) return { content: "(空文件)" };

    const start = Math.max(1, input.offset ?? 1);
    const end = Math.min(total, start + (input.limit ?? MAX_LINES) - 1);
    if (start > total) {
      return {
        content: `起始行 ${start} 超出文件总行数 ${total}。文件共 ${total} 行。`,
      };
    }

    const width = String(end).length;
    const numbered: string[] = [];
    for (let i = start; i <= end; i++) {
      const text = lines[i - 1] ?? "";
      numbered.push(`${String(i).padStart(width, " ")}\t${text}`);
    }
    let content = numbered.join("\n");
    if (end < total) {
      content += `\n...[文件共 ${total} 行，已显示 ${start}-${end} 行。可用 offset=${end + 1} 继续读取]`;
    }
    return { content };
  },
});

/** Windows 大小写不敏感的路径归一化键 */
export function normalizeKey(p: string): string {
  const unified = p.replace(/\\/g, "/");
  return process.platform === "win32" ? unified.toLowerCase() : unified;
}
