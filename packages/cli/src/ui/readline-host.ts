import readline from "node:readline";
import process from "node:process";
import type {
  AgentEvent,
  AgentHost,
  PermissionDecision,
  PermissionRequest,
} from "@wcode/core";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

/**
 * M1 极简 readline UI（AgentHost 实现）。
 * M3 换 ink 时整目录替换本文件，core 零改动。
 * 流式渲染策略：text_delta 直接 write（增量），工具行与提示走完整行。
 */
export class ReadlineHost implements AgentHost {
  private readonly rl: readline.Interface;
  /** 是否正在流式输出（流式期间不重绘 prompt） */
  private busy = false;

  constructor(rl: readline.Interface) {
    this.rl = rl;
  }

  emit(event: AgentEvent): void {
    switch (event.type) {
      case "text_delta":
        this.write(event.text);
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
    const input = JSON.stringify(req.input, null, 2);
    this.line(`  ${DIM}${input.length > 600 ? input.slice(0, 600) + "..." : input}${RESET}`);
    const answer = await this.question(`  允许执行? [y]是 / [a]总是 / [n]否 `);
    const normalized = answer.trim().toLowerCase();
    if (normalized === "a") return "allowAlways";
    if (normalized === "y") return "allow";
    return "deny";
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    if (!busy) this.rl.prompt();
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
