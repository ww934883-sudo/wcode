import { AutomationStore, errorMessage } from "@wcode/core";
import { createDefaultRunner, type AutomationRunner } from "./runner";

/**
 * 自动化守护进程（W-c）：周期扫描到期任务 → 认领 → 派发 `wcode -p` 子进程 → 记录运行。
 * `--tick` 模式只跑一轮就退出（测试 / 外部 cron 驱动）；默认常驻（setInterval + SIGINT）。
 */

export interface DaemonOptions {
  /** 只跑一轮即退（wcode daemon --tick） */
  once?: boolean;
  /** 常驻模式的扫描间隔，默认 60s */
  tickMs?: number;
  /** 测试注入家目录 */
  homeDir?: string;
  /** 测试注入派发器 */
  runner?: AutomationRunner;
  /** 注入存储（测试）；缺省打开 ~/.wcode/wcode.db，注入时由调用方管理 close */
  store?: AutomationStore;
  /** 测试注入信号源（默认 process） */
  signalSource?: { once(event: string, listener: () => void): unknown };
  write?: (line: string) => void;
}

/** 一轮扫描：顺序执行全部到期任务，返回本轮执行的个数 */
export async function daemonTick(
  store: AutomationStore,
  runner: AutomationRunner,
  write: (line: string) => void = (l) => console.log(l),
): Promise<number> {
  const due = store.due();
  let ran = 0;
  for (const automation of due) {
    if (!store.claim(automation.id)) {
      write(`[daemon] ${automation.title} 正被其他执行方持有，本轮跳过`);
      continue;
    }
    const { run } = store.startRun(automation.id, "schedule");
    write(`[daemon] 运行: ${automation.title}（${automation.id.slice(0, 8)}）`);
    try {
      const result = await runner(automation);
      store.finishRun(run.id, {
        outcome: result.outcome,
        exitCode: result.exitCode,
        sessionId: result.sessionId,
        error: result.error,
      });
      write(
        `[daemon] 完成: ${automation.title} → ${result.outcome}` +
          (result.sessionId ? `（会话 ${result.sessionId}）` : ""),
      );
    } catch (err) {
      // 基础设施失败（子进程起不来等）：运行行记 failed，任务进退避，不计入 run_count
      const msg = errorMessage(err);
      store.failRun(run.id, msg);
      store.recordDispatchFailure(automation.id, msg);
      write(`[daemon] 派发失败: ${automation.title} → ${msg}`);
    }
    ran++;
  }
  return ran;
}

export async function runDaemon(opts: DaemonOptions = {}): Promise<void> {
  const write = opts.write ?? ((l: string) => console.log(l));
  const runner = opts.runner ?? createDefaultRunner({ write });
  const store = opts.store ?? (await AutomationStore.open({ homeDir: opts.homeDir }));
  const ownsStore = !opts.store; // 注入的 store 由调用方管理生命周期

  if (opts.once) {
    try {
      const ran = await daemonTick(store, runner, write);
      write(`[daemon] --tick 本轮执行 ${ran} 个任务`);
    } finally {
      if (ownsStore) store.close();
    }
    return;
  }

  const tickMs = opts.tickMs ?? 60_000;
  write(`[daemon] 已启动，每 ${Math.round(tickMs / 1000)}s 检查到期任务；Ctrl+C 退出`);
  const tickLoop = async () => {
    try {
      await daemonTick(store, runner, write);
    } catch (err) {
      write(`[daemon] 本轮异常: ${errorMessage(err)}`);
    }
  };
  await tickLoop();
  const timer = setInterval(tickLoop, tickMs);

  // 常驻：用挂起的 Promise 阻住本函数，直到收到 SIGINT/SIGTERM。
  // 修复：此前注册完监听器后函数直接返回，bin.tsx 的 process.exit 导致 daemon 立即退出。
  const signals = opts.signalSource ?? process;
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      clearInterval(timer);
      if (ownsStore) store.close();
      write("[daemon] 已退出");
      resolve();
    };
    signals.once("SIGINT", shutdown);
    signals.once("SIGTERM", shutdown);
  });
}
