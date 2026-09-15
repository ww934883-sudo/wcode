#!/usr/bin/env node
/** wcode CLI 入口：参数解析 → 组合根装配 → REPL 循环 */
import readline from "node:readline";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSession,
  ConfigError,
  PermissionEngine,
  ToolRegistry,
  buildSystemPrompt,
  defaultPromptSections,
  errorMessage,
  isAbortedError,
  readTool,
  type AgentHost,
} from "@wcode/core";
import { FakeProvider, RecordingHost, endTurn, toolUseTurn } from "@wcode/core/testing";
import { bootstrap } from "./bootstrap";
import { ReadlineHost } from "./ui/readline-host";

const VERSION = "0.1.0";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }
  if (args.includes("--version")) {
    console.log(`wcode ${VERSION}`);
    return 0;
  }
  if (args.includes("--selftest")) {
    return selftest();
  }

  // 权限模式可用 --mode=acceptEdits 覆盖（生产级：CLI 层是配置最高层）
  const modeArg = args.find((a) => a.startsWith("--mode="));
  const mode = modeArg?.split("=")[1];
  const overrides = mode ? { permissions: { mode } } : undefined;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "wcode> ",
  });
  const host: AgentHost = new ReadlineHost(rl);

  try {
    const { session, config } = await bootstrap({ host, overrides });
    console.log(
      `${CYAN}wcode${RESET} 已就绪 — provider=${config.activeProvider} model=${config.model}` +
        `（权限模式 ${config.permissions.mode}；/quit 退出；Ctrl+C 中断当前任务）`,
    );

    let lastSigintAt = 0;
    rl.on("SIGINT", () => {
      const now = Date.now();
      if (now - lastSigintAt < 2000) {
        rl.close();
        return;
      }
      lastSigintAt = now;
      session.abort();
      process.stdout.write(`^C${DIM}（已请求中断当前任务；2 秒内再按一次退出）${RESET}\n`);
    });

    for await (const line of rl) {
      const input = line.trim();
      if (!input) {
        rl.prompt();
        continue;
      }
      if (input === "/quit" || input === "/exit") {
        rl.close();
        break;
      }
      (host as ReadlineHost).setBusy(true);
      try {
        const result = await session.run(input);
        if (result.status === "max_turns") {
          console.log(
            `${YELLOW}已达到单任务最大轮数，停下汇报进展。可用 /quit 退出后继续。${RESET}`,
          );
        }
      } catch (err) {
        if (!isAbortedError(err)) {
          console.error(`${RED}出错: ${errorMessage(err)}${RESET}`);
          if (err instanceof ConfigError) {
            rl.close();
            return 2;
          }
        }
      } finally {
        (host as ReadlineHost).setBusy(false);
      }
      rl.prompt();
    }
    return 0;
  } catch (err) {
    console.error(`${RED}${errorMessage(err)}${RESET}`);
    return err instanceof ConfigError ? 2 : 1;
  }
}

/** 无网络自检：FakeProvider 脚本化「读文件→回答」，验证整条循环 */
async function selftest(): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "wcode-selftest-"));
  try {
    const target = join(dir, "note.txt");
    await writeFile(target, "wcode selftest marker 42", "utf8");

    const provider = new FakeProvider([
      {
        response: toolUseTurn([
          { id: "t1", name: "read", input: { file_path: target } },
        ]),
      },
      { response: endTurn("selftest 完成：note.txt 内容包含 marker 42") },
    ]);
    const host = new RecordingHost();
    const registry = new ToolRegistry();
    await registry.registerSource({ id: "builtin", listTools: () => [readTool] });
    const session = new AgentSession({
      provider,
      registry,
      host,
      engine: new PermissionEngine(),
      system: buildSystemPrompt(defaultPromptSections, {
        cwd: dir,
        platform: process.platform,
      }),
      cwd: dir,
      retryDelaysMs: [1],
    });

    const result = await session.run("读取 note.txt 并告诉我内容");
    if (result.status === "end_turn" && result.reply.includes("marker 42")) {
      console.log(`selftest OK — ${result.reply}`);
      return 0;
    }
    console.error(`selftest FAIL: status=${result.status} reply=${result.reply}`);
    return 1;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function printHelp(): void {
  console.log(`wcode — 终端编程 Agent

用法:
  wcode [选项]

选项:
  --mode=<mode>   权限模式: plan | default | acceptEdits | bypass
  --selftest      无网络自检（验证 Agent 循环与工具管道）
  --version       显示版本
  -h, --help      显示帮助

配置:
  ~/.wcode/settings.json          全局配置
  .wcode/settings.json            项目配置
  环境变量 WCODE_LOG=debug        开启调试日志`);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`${RED}致命错误: ${errorMessage(err)}${RESET}`);
    process.exit(1);
  },
);
