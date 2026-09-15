import { readFile } from "node:fs/promises";
import readline from "node:readline";
import process from "node:process";
import type {
  AgentEvent,
  AgentHost,
  PermissionDecision,
  PermissionRequest,
} from "@wcode/core";
import { renderChecklist } from "@wcode/core";
import type { TodoItem } from "@wcode/core";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";

/**
 * M1 极简 readline UI（AgentHost 实现）。
 * M3 换 ink 时整目录替换本文件，core 零改动。
 * 流式渲染策略：text_delta 直接 write（增量），工具行与提示走完整行。
 */
export class ReadlineHost implements AgentHost {
  private readonly rl: readline.Interface;

  constructor(rl: readline.Interface) {
    this.rl = rl;
  }

  emit(event: AgentEvent): void {
    switch (event.type) {
      case "text_delta":
        process.stdout.write(event.text);
        break;
      case "tool_start":
        this.line(`\n${CYAN}⏺ ${event.call.name}${RESET}`);
        break;
      case "tool_end":
        this.line(
          `  ${DIM}⎿ ${event.ok ? "" : `${RED}失败: `}${event.summary} (${event.durationMs}ms)${RESET}`,
        );
        break;
      case "usage":
        this.line(
          `\n${DIM}[tokens: in ${event.cumulative.inputTokens} / out ${event.cumulative.outputTokens}]${RESET}`,
        );
        break;
      case "todos_changed":
        this.renderTodos(event.todos);
        break;
      case "compacted":
        this.line(`\n${YELLOW}⊗ ${event.note}${RESET}`);
        break;
      case "error":
        this.line(`\n${YELLOW}! ${event.message}${RESET}`);
        break;
      case "done":
        this.write("\n");
        break;
      case "turn_start":
      default:
        break;
    }
  }

  async requestPermission(req: PermissionRequest): Promise<PermissionDecision> {
    this.line("");
    this.line(`${YELLOW}需要权限: ${req.toolName}${RESET}`);
    if (req.patterns.length > 0) {
      this.line(`  ${DIM}匹配: ${req.patterns.join(", ")}${RESET}`);
    }
    // diff 确认（架构文档 M2：编辑类工具展示变更预览）
    const preview = await this.buildDiffPreview(req);
    if (preview) {
      this.line(preview);
    } else {
      const input = JSON.stringify(req.input, null, 2);
      this.line(`  ${DIM}${input.length > 600 ? input.slice(0, 600) + "..." : input}${RESET}`);
    }
    const answer = await this.question(`  允许执行? [y]是 / [a]总是 / [n]否 `);
    const normalized = answer.trim().toLowerCase();
    if (normalized === "a") return "allowAlways";
    if (normalized === "y") return "allow";
    return "deny";
  }

  /** edit → 替换区域 diff；write 覆盖已有文件 → 新内容预览；其他工具无预览 */
  private async buildDiffPreview(req: PermissionRequest): Promise<string | null> {
    try {
      if (req.toolName === "edit") {
        const input = req.input as { file_path?: string; old_string?: string; new_string?: string };
        if (!input.file_path || input.old_string === undefined || input.new_string === undefined) {
          return null;
        }
        const content = await readFile(input.file_path, "utf8").catch(() => null);
        if (content === null || !content.includes(input.old_string)) return null;
        const idx = content.indexOf(input.old_string);
        const before = content.slice(0, idx);
        const after = content.slice(idx + input.old_string.length);
        const ctxLines = (s: string, fromEnd = false) =>
          (fromEnd ? s.split("\n").slice(-2) : s.split("\n").slice(0, 2)).filter(
            (l) => l !== "",
          );
        const lines = [
          `  ${DIM}--- ${input.file_path}${RESET}`,
          ...ctxLines(before).map((l) => `  ${DIM} ${l}${RESET}`),
          ...input.old_string.split("\n").map((l) => `  ${RED}-${l}${RESET}`),
          ...input.new_string.split("\n").map((l) => `  ${GREEN}+${l}${RESET}`),
          ...ctxLines(after, true).map((l) => `  ${DIM} ${l}${RESET}`),
        ];
        return lines.join("\n");
      }
      if (req.toolName === "write") {
        const input = req.input as { file_path?: string; content?: string };
        if (!input.file_path || input.content === undefined) return null;
        const lineCount = input.content.split("\n").length;
        const head = input.content.split("\n").slice(0, 15).map((l) => `  ${GREEN}+${l}${RESET}`);
        const more = lineCount > 15 ? `\n  ${DIM}...（共 ${lineCount} 行）${RESET}` : "";
        return `  ${DIM}--- ${input.file_path}（整文件写入）${RESET}\n${head.join("\n")}${more}`;
      }
    } catch {
      return null; // 预览失败不阻塞权限询问
    }
    return null;
  }

  private renderTodos(todos: TodoItem[]): void {
    if (todos.length === 0) return;
    this.line(`\n${CYAN}任务清单:${RESET}`);
    this.line(
      todos
        .map((t) => `  ${renderChecklist([t])}`)
        .join("\n"),
    );
  }

  setBusy(_busy: boolean): void {
    // readline 模式下 prompt 由 REPL 控制，保留接口给 M3 ink 实现
  }

  question(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(prompt, resolve);
    });
  }

  private write(text: string): void {
    process.stdout.write(text);
  }

  private line(text: string): void {
    process.stdout.write(text + "\n");
  }
}
