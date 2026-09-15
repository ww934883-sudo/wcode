import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PromptSection } from "./sections";

export interface LoadAgentsMdOptions {
  cwd: string;
  /** 默认 ~/.wcode（测试注入） */
  homeDir?: string;
}

/**
 * 项目记忆（架构文档 §9 / §2.8 PromptSection）：
 * 全局 ~/.wcode/AGENTS.md → 项目 AGENTS.md → 兼容读取 CLAUDE.md，依序拼接。
 */
export async function loadAgentsMdFiles(
  opts: LoadAgentsMdOptions,
): Promise<string> {
  const homeDir = opts.homeDir ?? join(homedir(), ".wcode");
  const files = [
    join(homeDir, "AGENTS.md"),
    join(opts.cwd, "AGENTS.md"),
    join(opts.cwd, "CLAUDE.md"),
  ];
  const parts: string[] = [];
  for (const f of files) {
    try {
      const text = await readFile(f, "utf8");
      if (text.trim()) parts.push(text.trim());
    } catch {
      /* 文件不存在跳过 */
    }
  }
  return parts.join("\n\n");
}

/** 内容为空时返回 null（不渲染该 section） */
export function createAgentsMdSection(content: string): PromptSection | null {
  if (!content.trim()) return null;
  return {
    id: "agents-md",
    render: () =>
      `以下是用户为本环境提供的长期指令（AGENTS.md），必须全程遵守：\n\n${content}`,
  };
}
