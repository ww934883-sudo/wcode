import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AutomationStore,
  dispatchBackoffMs,
  nextCronRun,
  type AutomationSpec,
} from "./store";

async function makeStore(): Promise<{ store: AutomationStore; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "wcode-auto-"));
  const store = await AutomationStore.open({ homeDir: home });
  return { store, home };
}

const cronSpec = (title: string, prompt: string): AutomationSpec => ({
  title,
  prompt,
  cwd: "D:/proj",
  schedule: { kind: "cron", expr: "0 9 * * 1-5" },
});

const onceSpec = (runAt: number): AutomationSpec => ({
  title: "一次性任务",
  prompt: "做一件事",
  cwd: "D:/proj",
  schedule: { kind: "once", runAt },
});

describe("nextCronRun", () => {
  it("计算下一次触发（本地时区）；非法表达式拒绝", () => {
    // 周三 06:30 → 当天 09:00
    const wed = nextCronRun("0 9 * * 1-5", new Date(2026, 8, 16, 6, 30));
    expect(wed?.getFullYear()).toBe(2026);
    expect(wed?.getHours()).toBe(9);
    expect(wed?.getMinutes()).toBe(0);
    expect(() => nextCronRun("99 99 * * *", new Date())).toThrow();
  });
});

describe("AutomationStore", () => {
  it("add/list/get（前缀匹配）", async () => {
    const { store, home } = await makeStore();
    try {
      const a = store.add(cronSpec("每日报表", "出报表"));
      expect(a.scheduleKind).toBe("cron");
      expect(a.cronExpr).toBe("0 9 * * 1-5");
      expect(a.enabled).toBe(true);
      expect(a.nextRunAt).toBeGreaterThan(Date.now() - 1000);
      expect(a.projectHash).toBeTruthy();

      const b = store.add(onceSpec(Date.now() + 60_000));
      expect(b.scheduleKind).toBe("once");
      expect(b.nextRunAt).toBe(b.runAt);

      expect(store.list()).toHaveLength(2);
      const prefix = a.id.slice(0, 8);
      expect(store.get(prefix).id).toBe(a.id);
      expect(() => store.get("zzz-none")).toThrow(/没有找到/);
    } finally {
      store.close();
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("once 的 add 拒绝过去时间；cron 的 add 拒绝空表达式", async () => {
    const { store, home } = await makeStore();
    try {
      expect(() => store.add(onceSpec(Date.now() - 1000))).toThrow(/未来的时间/);
      expect(() =>
        store.add({ ...cronSpec("x", "y"), schedule: { kind: "cron" } }),
      ).toThrow(/--cron/);
    } finally {
      store.close();
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("due/claim 互斥：认领后不再 due；重复认领被拒", async () => {
    const { store, home } = await makeStore();
    try {
      const a = store.add(onceSpec(Date.now() + 60_000));
      patchNextRun(store, a.id, Date.now() - 1000); // 拨到已到期
      const dueIds = store.due().map((r) => r.id);
      expect(dueIds).toContain(a.id);

      expect(store.claim(a.id)).toBe(true);
      expect(store.claim(a.id)).toBe(false); // 互斥
      expect(store.due().map((r) => r.id)).not.toContain(a.id);
    } finally {
      store.close();
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("finishRun 状态机：cron 推进下一轮；once 完成即停用；max_runs 达标停用", async () => {
    const { store, home } = await makeStore();
    try {
      const cron = store.add(cronSpec("cron", "提示词"));
      patchNextRun(store, cron.id, Date.now() - 1000);
      expect(store.claim(cron.id)).toBe(true);
      const { run } = store.startRun(cron.id, "schedule");
      store.finishRun(run.id, { outcome: "success", exitCode: 0, sessionId: "sess-1" });
      const afterCron = store.get(cron.id);
      expect(afterCron.running).toBe(false);
      expect(afterCron.runCount).toBe(1);
      expect(afterCron.enabled).toBe(true);
      expect(afterCron.nextRunAt!).toBeGreaterThan(Date.now() - 1000);

      const once = store.add(onceSpec(Date.now() + 1000));
      patchNextRun(store, once.id, Date.now() - 1000);
      store.claim(once.id);
      const onceRun = store.startRun(once.id, "schedule");
      store.finishRun(onceRun.run.id, { outcome: "success", exitCode: 0 });
      const afterOnce = store.get(once.id);
      expect(afterOnce.enabled).toBe(false);
      expect(afterOnce.nextRunAt).toBeNull();
      expect(afterOnce.runCount).toBe(1);

      const limited = store.add({ ...cronSpec("限量", "提示词"), maxRuns: 1 });
      patchNextRun(store, limited.id, Date.now() - 1000);
      store.claim(limited.id);
      const limitedRun = store.startRun(limited.id, "schedule");
      store.finishRun(limitedRun.run.id, { outcome: "max_turns", exitCode: 0 });
      expect(store.get(limited.id).enabled).toBe(false);

      const logs = store.runs(cron.id);
      expect(logs).toHaveLength(1);
      expect(logs[0]?.outcome).toBe("success");
      expect(logs[0]?.sessionId).toBe("sess-1");
    } finally {
      store.close();
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("recordDispatchFailure：指数退避、不推进调度、恢复时清退避", async () => {
    const { store, home } = await makeStore();
    try {
      const a = store.add(cronSpec("退避", "提示词"));
      patchNextRun(store, a.id, Date.now() - 1000);
      store.claim(a.id);
      store.recordDispatchFailure(a.id, "spawn 失败");
      const after = store.get(a.id);
      expect(after.running).toBe(false);
      expect(after.dispatchAttempts).toBe(1);
      expect(after.retryAt!).toBeGreaterThan(Date.now());
      expect(after.nextRunAt!).toBeLessThan(Date.now()); // 调度时间不推进
      expect(store.due()).toHaveLength(0); // 退避期内不 due

      const paused = store.setEnabled(a.id, false);
      expect(paused.enabled).toBe(false);
      const resumed = store.setEnabled(a.id, true);
      expect(resumed.enabled).toBe(true);
      expect(resumed.retryAt).toBeNull();
      expect(resumed.dispatchAttempts).toBe(0);
      expect(resumed.nextRunAt!).toBeGreaterThan(Date.now() - 1000);
    } finally {
      store.close();
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("remove 级联删除运行历史；recentRuns 带 title", async () => {
    const { store, home } = await makeStore();
    try {
      const a = store.add(cronSpec("有历史的任务", "提示词"));
      store.claim(a.id);
      const { run } = store.startRun(a.id, "manual");
      store.finishRun(run.id, { outcome: "failed", exitCode: 1, error: "boom" });
      expect(store.recentRuns()[0]?.title).toBe("有历史的任务");
      store.remove(a.id);
      expect(store.list()).toHaveLength(0);
      expect(store.recentRuns()).toHaveLength(0); // CASCADE
    } finally {
      store.close();
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("dispatchBackoffMs 指数封顶", () => {
    expect(dispatchBackoffMs(1)).toBe(60_000);
    expect(dispatchBackoffMs(2)).toBe(120_000);
    expect(dispatchBackoffMs(3)).toBe(240_000);
    expect(dispatchBackoffMs(20)).toBe(3_600_000);
  });
});

/** 测试钩子：拨动 next_run_at 绕过 add 的未来时间校验，模拟已到期 */
function patchNextRun(store: AutomationStore, id: string, nextRunAt: number): void {
  store.patchNextRunForTest(id, nextRunAt);
}
