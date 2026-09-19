import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleScheduleCommand, type ScheduleIo } from "./schedule";

function makeIo(home: string): { io: ScheduleIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      homeDir: home,
    },
    out,
    err,
  };
}

describe("schedule add 的权限模式校验", () => {
  it("非法 --mode 在入口即拒绝，不写入任务", async () => {
    const home = await mkdtemp(join(tmpdir(), "wcode-schedule-"));
    try {
      const { io, err } = makeIo(home);
      const code = await handleScheduleCommand(
        ["add", "跑测试", "--cron=0 9 * * *", "--mode=yolo"],
        io,
      );
      expect(code).toBe(2);
      expect(err.join("\n")).toContain("非法权限模式");
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("合法 --mode 正常创建并回显", async () => {
    const home = await mkdtemp(join(tmpdir(), "wcode-schedule-"));
    try {
      const { io, out } = makeIo(home);
      const code = await handleScheduleCommand(
        ["add", "跑测试", "--cron=0 9 * * *", "--mode=acceptEdits"],
        io,
      );
      expect(code).toBe(0);
      expect(out.join("\n")).toContain("权限模式: acceptEdits");
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });
});
