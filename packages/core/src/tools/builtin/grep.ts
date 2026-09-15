import { spawn } from "node:child_process";
import fg from "fast-glob";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "../tool";

const RG_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 100;
const MAX_FILE_BYTES = 1_000_000;

const GrepSchema = z.object({
  pattern: z.string().min(1).describe("正则表达式（Rust regex 语法）"),
  path: z.string().optional().describe("搜索根目录，默认工作目录"),
  include: z.string().optional().describe('文件名过滤 glob，如 "*.ts"'),
});

export const grepTool = defineTool({
  name: "grep",
  description:
    "按正则表达式搜索文件内容，输出 `文件:行号: 匹配行`。优先使用 ripgrep，" +
    "不可用时自动降级为内置扫描。搜文件名用 glob 工具。",
  schema: GrepSchema,
  isReadOnly: true,
  rulePatterns: (input) => [`grep(${input.pattern})`],
  execute: async (input, ctx) => {
    const root = input.path
      ? isAbsolute(input.path)
        ? input.path
        : resolve(ctx.session.cwd, input.path)
      : ctx.session.cwd;

    let result = await ripgrepSearch({ ...input, root });
    if (result === null) {
      result = await fallbackSearch({ ...input, root });
    }

    if (result.matches.length === 0) {
      return { content: `无匹配: /${input.pattern}/（root=${root}）` };
    }
    let content = result.matches.join("\n");
    if (result.truncated) {
      content += `\n...[仅显示前 ${MAX_RESULTS} 条匹配，请收窄 pattern 或缩小 path]`;
    }
    return { content };
  },
});

interface SearchArgs {
  pattern: string;
  root: string;
  include?: string;
}

interface SearchResult {
  matches: string[];
  truncated: boolean;
}

/** 返回 null 表示 ripgrep 不可用（需要降级） */
async function ripgrepSearch(args: SearchArgs): Promise<SearchResult | null> {
  const rgArgs = [
    "-n",
    "--no-heading",
    "--color",
    "never",
    "--max-columns",
    "300",
    "-e",
    args.pattern,
  ];
  if (args.include) rgArgs.push("--glob", args.include);
  rgArgs.push(".");

  try {
    const proc = spawn("rg", rgArgs, {
      cwd: args.root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 2_000_000) stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", () => {
      /* 退出码非 0/1 的情况按无结果处理，stderr 不上抛 */
    });
    const timedOut = await new Promise<boolean>((resolve2) => {
      const timer = setTimeout(() => {
        proc.kill();
        resolve2(true);
      }, RG_TIMEOUT_MS);
      // rg 无匹配时退出码为 1，属正常；其他非零退出按无结果处理
      proc.on("close", () => {
        clearTimeout(timer);
        resolve2(false);
      });
    });
    if (timedOut) return { matches: [], truncated: true };

    const matches = stdout
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(0, MAX_RESULTS + 1);
    return {
      matches: matches.slice(0, MAX_RESULTS),
      truncated: matches.length > MAX_RESULTS,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null; // rg 不存在 → 降级
    return { matches: [], truncated: false };
  }
}

async function fallbackSearch(args: SearchArgs): Promise<SearchResult> {
  let regex: RegExp;
  try {
    regex = new RegExp(args.pattern);
  } catch (err) {
    return { matches: [`正则表达式无效: ${(err as Error).message}`], truncated: false };
  }
  const files = await fg(args.include ?? "**/*", {
    cwd: args.root,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    suppressErrors: true,
    ignore: ["**/node_modules/**", "**/.git/**"],
  });

  const matches: string[] = [];
  for (const rel of files) {
    if (matches.length >= MAX_RESULTS) break;
    let text: string;
    try {
      const abs = join(args.root, rel);
      const st = await readFile(abs);
      if (st.byteLength > MAX_FILE_BYTES || st.includes(0)) continue;
      text = st.toString("utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && matches.length < MAX_RESULTS; i++) {
      if (regex.test(lines[i] ?? "")) {
        matches.push(`${rel}:${i + 1}: ${(lines[i] ?? "").trim().slice(0, 300)}`);
      }
    }
  }
  return { matches, truncated: matches.length >= MAX_RESULTS };
}
