import fg from "fast-glob";
import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "../tool";

const MAX_RESULTS = 200;

const GlobSchema = z.object({
  pattern: z.string().min(1).describe("glob 模式，如 src/**/*.ts 或 **/*.md"),
  path: z.string().optional().describe("搜索根目录，默认工作目录"),
});

export const globTool = defineTool({
  name: "glob",
  description:
    "按文件名 glob 模式搜索文件（不搜内容，搜内容用 grep）。" +
    "返回按修改时间倒序的文件列表，最多 200 条。",
  schema: GlobSchema,
  isReadOnly: true,
  rulePatterns: (input) => [`glob(${input.pattern})`],
  execute: async (input, ctx) => {
    const root = input.path
      ? isAbsolute(input.path)
        ? input.path
        : resolve(ctx.session.cwd, input.path)
      : ctx.session.cwd;

    const found = await fg(input.pattern, {
      cwd: root,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    });
    if (found.length === 0) {
      return { content: `无匹配文件: ${input.pattern}（root=${root}）` };
    }

    // 按修改时间倒序（最近改动的优先看）
    const withMtime = await Promise.all(
      found.map(async (rel) => {
        try {
          const st = await stat(join(root, rel));
          return { rel, mtimeMs: st.mtimeMs };
        } catch {
          return { rel, mtimeMs: 0 };
        }
      }),
    );
    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const shown = withMtime.slice(0, MAX_RESULTS);
    // fast-glob 恒定返回 / 分隔符，跨平台一致
    const lines = shown.map((e) => e.rel);
    let content = `共 ${withMtime.length} 个匹配文件:\n${lines.join("\n")}`;
    if (withMtime.length > MAX_RESULTS) {
      content += `\n...[仅显示前 ${MAX_RESULTS} 条，请收窄 pattern]`;
    }
    return { content };
  },
});
