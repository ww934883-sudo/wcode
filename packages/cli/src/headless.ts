import { ConfigError, errorMessage } from "@wcode/core";
import type {
  AgentEvent,
  AgentHost,
  ModelProvider,
  PermissionDecision,
  PermissionRequest,
} from "@wcode/core";
import { bootstrap } from "./bootstrap";

/**
 * 无头宿主（AgentHost 第三实现，接缝三）：无 TTY 的自动化场景。
 * 进度写 stderr（工具行/错误/压缩），权限询问自动拒绝——
 * 自动化需要放行时用 --mode=bypass、acceptEdits 或配置 allow 规则。
 */
export class HeadlessHost implements AgentHost {
  readonly lines: string[] = [];

  constructor(private readonly write: (line: string) => void = (l) => console.error(l)) {}

  emit(event: AgentEvent): void {
    switch (event.type) {
      case "tool_end":
        this.write(
          `⏺ ${event.toolName} ${event.ok ? "" : "✗ "}${event.summary} (${event.durationMs}ms)`,
        );
        break;
      case "error":
        this.write(`! ${event.message}`);
        break;
      case "compacted":
        this.write(`⊗ ${event.note}`);
        break;
      default:
        break; // turn_start/usage/todos 在无头模式不打扰输出
    }
  }

  async requestPermission(req: PermissionRequest): Promise<PermissionDecision> {
    this.write(`[权限] 无头模式自动拒绝: ${req.toolName}(${req.patterns.join(", ")})`);
    return "deny";
  }
}

export interface HeadlessResult {
  /** 退出码：0 成功，1 运行错误，2 配置错误 */
  code: number;
  stdout: string;
  status?: "end_turn" | "max_turns" | "aborted";
  reply?: string;
}

/**
 * 无头运行（自动化原语）：bootstrap → session.run → 输出结果退出。
 * text 模式 stdout=最终回复；json 模式输出 {status, reply, usage, model}。
 * provider 可注入（测试/自检），缺省按配置创建真实 provider。
 */
export async function runHeadless(opts: {
  prompt: string;
  outputFormat?: "text" | "json";
  overrides?: Record<string, unknown>;
  /** 接最近一次会话（定时任务的续跑场景） */
  resume?: boolean;
  provider?: ModelProvider;
  cwd?: string;
  /** 家目录覆盖（测试隔离 ~/.wcode；缺省 homedir()） */
  homeDir?: string;
  writeStderr?: (line: string) => void;
}): Promise<HeadlessResult> {
  const outputFormat = opts.outputFormat ?? "text";
  const write = opts.writeStderr ?? ((l: string) => console.error(l));
  const host = new HeadlessHost(write);
  try {
    const { session, config, sessionId, sessions } = await bootstrap({
      host,
      overrides: opts.overrides,
      cwd: opts.cwd,
      homeDir: opts.homeDir,
      provider: opts.provider,
      resume: opts.resume,
    });
    try {
      const result = await session.run(opts.prompt);
      if (result.status === "max_turns") {
        write("[提示] 已达单任务最大轮数，输出为当前进展（不完整）");
      }
      if (outputFormat === "json") {
        const stdout = JSON.stringify(
          {
            status: result.status,
            reply: result.reply,
            usage: session.state.cumulativeUsage,
            model: config.model,
            sessionId,
          },
          null,
          2,
        );
        return { code: 0, stdout, status: result.status, reply: result.reply };
      }
      return { code: 0, stdout: result.reply, status: result.status, reply: result.reply };
    } finally {
      // 关闭会话库（WAL 检查点）：进程随即退出，且测试可立刻清理临时目录
      sessions.close();
    }
  } catch (err) {
    write(`出错: ${errorMessage(err)}`);
    return { code: err instanceof ConfigError ? 2 : 1, stdout: "" };
  }
}
