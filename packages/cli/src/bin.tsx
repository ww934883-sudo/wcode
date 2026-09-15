#!/usr/bin/env node
/** wcode CLI 入口：参数解析 → 组合根装配 → ink TUI */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import React from "react";
import {
  AgentSession,
  ConfigError,
  PermissionEngine,
  ToolRegistry,
  buildSystemPrompt,
  builtinToolSource,
  defaultPromptSections,
  errorMessage,
  isAbortedError,
  readTool,
  type AgentHost,
} from "@wcode/core";
import { FakeProvider, RecordingHost, endTurn, toolUseTurn } from "@wcode/core/testing";
import { bootstrap, createProvider } from "./bootstrap";
import { handleSlashCommand, type CommandDeps, type CommandSink } from "./commands";
import { InkHost } from "./ui/ink-host";
import { App } from "./ui/App";

const VERSION = "0.1.0";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

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
  const resume = args.includes("--continue") || args.includes("-c");

  const host = new InkHost();

  try {
    const { session, config, skills, provider } = await bootstrap({ host, overrides, resume });
    host.pushHistory({
      kind: "welcome",
      text:
        `wcode 已就绪 — provider=${config.activeProvider} model=${config.model}` +
        `（权限模式 ${config.permissions.mode}${resume ? "，已恢复上一会话" : ""}` +
        `${skills.length > 0 ? `，技能 ${skills.map((s) => `/${s.name}`).join(" ")}` : ""}）` +
        " /help 查看命令",
    });

    // 斜杠命令层：内置命令本地处理，/btw 直答有自己的中断控制器
    const btwAbort: { current: AbortController | null } = { current: null };
    const sink: CommandSink = {
      note: (t) => host.pushHistory({ kind: "note", text: t }),
      assistant: (t) => host.pushHistory({ kind: "assistant", text: t }),
      error: (t) => host.pushHistory({ kind: "error", text: t }),
    };
    const commandDeps: CommandDeps = {
      session,
      skills,
      config,
      provider,
      createModelProvider: (model) => createProvider({ ...config, model }),
      host,
      btwAbort,
    };

    const app = render(
      <App
        host={host}
        onSubmit={async (raw) => {
          const cmd = await handleSlashCommand(raw, commandDeps, sink);
          if (cmd.kind === "handled") return;
          try {
            const result = await session.run(cmd.text);
            if (result.status === "max_turns") {
              host.pushHistory({
                kind: "error",
                text: "已达到单任务最大轮数，停下汇报进展",
              });
            }
          } catch (err) {
            if (!isAbortedError(err)) {
              host.pushHistory({ kind: "error", text: `出错: ${errorMessage(err)}` });
            }
          }
        }}
        onAbort={() => {
          session.abort();
          btwAbort.current?.abort();
        }}
      />,
      { exitOnCtrlC: false },
    );

    // 非交互冒烟：渲染管线验证（CI/无 TTY 环境用）
    if (process.env.WCODE_UI_SMOKE === "1") {
      host.pushHistory({ kind: "user", text: "看看 demo" });
      host.emit({ type: "text_delta", text: "这是 **markdown** 渲染，含 `行内码`。" });
      host.emit({
        type: "tool_start",
        call: { id: "s1", name: "read", input: {} },
      });
      host.emit({
        type: "tool_end",
        callId: "s1",
        toolName: "read",
        ok: true,
        summary: "src/app.ts（12 行）",
        durationMs: 42,
      });
      host.emit({
        type: "todos_changed",
        todos: [
          { content: "定位问题", status: "completed" },
          { content: "修复并验证", status: "in_progress", priority: "high" },
        ],
      });
      host.setBusy(true);
      setTimeout(() => host.setBusy(false), 300);
      setTimeout(() => app.unmount(), 800);
    }

    await app.waitUntilExit();
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
    await registry.registerSource(builtinToolSource);
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
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(
      () => {},
    );
  }
}

function printHelp(): void {
  console.log(`wcode — 终端编程 Agent

用法:
  wcode [选项]

选项:
  --mode=<mode>   权限模式: plan | default | acceptEdits | bypass
  -c, --continue  恢复最近一次会话
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
