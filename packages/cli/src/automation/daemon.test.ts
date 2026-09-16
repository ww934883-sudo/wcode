import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationStore, type AutomationSpec } from "@wcode/core";
import { daemonTick, runDaemon } from "./daemon";
import { runAutomationManually } from "./schedule";
import type { AutomationDispatchResult, AutomationRunner } from "./runner";

async function makeStore(): Promise<{ store: AutomationStore; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "wcode-daemon-"));
  const store = await AutomationStore.open({ homeDir: home });
  return { store, home };
}

const cronSpec = (prompt: string): AutomationSpec => ({
  title: "每日报表",
  prompt,
  cwd: "D:/proj",
  schedule: { kind: "cron", expr: "0 9 * * 1-5" },
});

const okRunner: AutomationRunner = async (automation) => ({
  outcome: "success",
  exitCode: 0,
  sessionId: "sess-daemon-1",
  reply: `done: ${automation.prompt}`,
});

describe("daemonTick", () => {
  it("到期任务被派发：运行记录、cron 推进下一轮", async () => {
    const { store, home } = await makeStore();
    try {
      const a = store.add(cronSpec("出报表"));
      store.patchNextRunForTest(a.id, Date.now() - 1000);
      const lines: string[] = [];
      const ran = await daemonTick(store, okRunner, (l) => lines.push(l));
      expect(ran).toBe(1);

      const after = store.get(a.id);
      expect(after.running).toBe(false);
      expect(after.runCount).toBe(1);
      expect(after.enabled).toBe(true);
      expect(after.nextRunAt!).toBeGreaterThan(Date.now() - 1000); // cron 已排下一轮
      const runRow = store.runs(a.id)[0];
      expect(runRow?.outcome).toBe("success");
      expect(runRow?.trigger).toBe("schedule");
      expect(runRow?.sessionId).toBe("sess-daemon-1");
      expect(lines.join("\n")).toContain("运行: 每日报表");
    } finally {
      store.close();
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("runner 抛错（基础设施失败）→ 运行行 failed + 退避，不推进调度", async () => {
    const { store, home } = await makeStore();
    try {
      const a = store.add(cronSpec("必失败"));
      store.patchNextRunForTest(a.id, Date.now() - 1000);
      const boom: AutomationRunner = async () => {
        throw new Error("spawn 失败");
      };
      const ran = await daemonTick(store, boom, () => {});
      expect(ran).toBe(1);
      const after = store.get(a.id);
      expect(after.runCount).toBe(0); // 不计入
      expect(after.dispatchAttempts).toBe(1);
      expect(after.retryAt!).toBeGreaterThan(Date.now());
      expect(store.runs(a.id)[0]?.outcome).toBe("failed");
      expect(store.due()).toHaveLength(0); // 退避期内不 due
    } finally {
      store.close();
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("max_turns 结局照常推进调度并记录", async () => {
    const { store, home } = await makeStore();
    try {
      const a = store.add(cronSpec("跑不完的任务"));
      store.patchNextRunForTest(a.id, Date.now() - 1000);
      const partial: AutomationRunner = async () => ({
        outcome: "max_turns",
        exitCode: 0,
        sessionId: "sess-partial",
        error: "已达单任务最大轮数",
      });
      await daemonTick(store, partial, () => {});
      const after = store.get(a.id);
      expect(after.runCount).toBe(1);
      expect(after.enabled).toBe(true); // cron 继续下一轮
      expect(store.runs(a.id)[0]?.outcome).toBe("max_turns");
    } finally {
      store.close();
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("runDaemon（--tick 单轮模式）", () => {
  // runDaemon 内部会打开并关闭共享连接，断言用的 store 在其后重开
  it("未到期的任务不执行；写出到轮次日志", async () => {
    const home = await mkdtemp(join(tmpdir(), "wcode-daemon-once-"));
    try {
      let store = await AutomationStore.open({ homeDir: home });
      const future = store.add({ ...cronSpec("还早"), schedule: { kind: "once", runAt: Date.now() + 3_600_000 } });
      store.close();

      const lines: string[] = [];
      await runDaemon({
        once: true,
        homeDir: home,
        runner: okRunner,
        write: (l) => lines.push(l),
      });
      expect(lines.join("\n")).toContain("本轮执行 0 个任务");

      store = await AutomationStore.open({ homeDir: home });
      expect(store.runs(future.id)).toHaveLength(0);
      store.close();
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("到期任务执行并记录", async () => {
    const home = await mkdtemp(join(tmpdir(), "wcode-daemon-once2-"));
    try {
      let store = await AutomationStore.open({ homeDir: home });
      const a = store.add({ ...cronSpec("到期就跑"), schedule: { kind: "once", runAt: Date.now() + 60_000 } });
      store.patchNextRunForTest(a.id, Date.now() - 1000);
      store.close();

      const lines: string[] = [];
      await runDaemon({
        once: true,
        homeDir: home,
        runner: okRunner,
        write: (l) => lines.push(l),
      });
      expect(lines.join("\n")).toContain("本轮执行 1 个任务");

      store = await AutomationStore.open({ homeDir: home });
      expect(store.runs(a.id)[0]?.sessionId).toBe("sess-daemon-1");
      store.close();
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("runAutomationManually（schedule run）", () => {
  it("手动执行成功并记录 manual 运行", async () => {
    const { store, home } = await makeStore();
    try {
      const a = store.add(cronSpec("手动跑"));
      const result = await runAutomationManually(store, a.id.slice(0, 8), okRunner);
      expect(result.outcome).toBe("success");
      const after = store.get(a.id);
      expect(after.runCount).toBe(1);
      expect(after.enabled).toBe(true);
      const runRow = store.runs(a.id)[0];
      expect(runRow?.trigger).toBe("manual");
      expect(runRow?.sessionId).toBe("sess-daemon-1");
    } finally {
      store.close();
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("被 daemon 持有时拒绝手动执行", async () => {
    const { store, home } = await makeStore();
    try {
      const a = store.add(cronSpec("占用中"));
      store.claim(a.id); // 模拟 daemon 持有
      await expect(
        runAutomationManually(store, a.id, okRunner),
      ).rejects.toThrow(/正在运行|持有/);
      expect(store.runs(a.id)).toHaveLength(0);
    } finally {
      store.close();
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });
});
