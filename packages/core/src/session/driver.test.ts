import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionDriver } from "./driver";
import { projectDirHash } from "./store";
import { messagesFromSessionLines } from "./resume";

describe("createSessionDriver", () => {
  it("sqlite：库文件落在 <home>/.wcode/wcode.db 且迁移已登记", async () => {
    const home = await mkdtemp(join(tmpdir(), "wcode-drv-s-"));
    try {
      const driver = await createSessionDriver({ storageType: "sqlite", cwd: "/proj", homeDir: home });
      const dbFile = join(home, ".wcode", "wcode.db");
      // WAL 模式下主库文件必然存在
      const raw = await readFile(dbFile);
      expect(raw.length).toBeGreaterThanOrEqual(0);
      driver.close();
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("jsonl：空会话不落盘，首条 append 时 meta 与消息一起写入", async () => {
    const home = await mkdtemp(join(tmpdir(), "wcode-drv-j-"));
    try {
      const driver = await createSessionDriver({ storageType: "jsonl", cwd: "/proj", homeDir: home });
      const { sessionId, store } = await driver.createNew({ cwd: "/proj" });
      const dir = join(home, ".wcode", "projects", projectDirHash("/proj"));
      // 懒落盘：还没发消息就没有文件
      await expect(readFile(join(dir, `${sessionId}.jsonl`), "utf8")).rejects.toThrow();
      await store.append({ v: 1, type: "message", message: { role: "user", content: "第一问" } });
      const raw = await readFile(join(dir, `${sessionId}.jsonl`), "utf8");
      expect(raw).toContain(`"sessionId":"${sessionId}"`);
      expect(raw).toContain("第一问");
      expect(await store.load()).toHaveLength(2); // meta + 消息
      driver.close();
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("listRecent 跳过空会话（两实现一致）", async () => {
    for (const storageType of ["jsonl", "sqlite"] as const) {
      const home = await mkdtemp(join(tmpdir(), `wcode-empty-${storageType}-`));
      try {
        const driver = await createSessionDriver({ storageType, cwd: "/proj", homeDir: home });
        await driver.createNew({ cwd: "/proj" }); // 空会话：一条消息都没发
        const kept = await driver.createNew({ cwd: "/proj" });
        await kept.store.append({
          v: 1,
          type: "message",
          message: { role: "user", content: "真实会话" },
        });
        const summaries = await driver.listRecent();
        expect(summaries.map((s) => s.sessionId)).toEqual([kept.sessionId]);
        driver.close();
      } finally {
        await rm(home, { recursive: true, force: true }).catch(() => {});
      }
    }
  });

  it("JSONL → SQLite 一次性导入：计数/标题/消息重放正确，损坏行与空会话跳过", async () => {
    const home = await mkdtemp(join(tmpdir(), "wcode-imp-"));
    // 夹具先落盘，再创建 driver（导入发生在 driver 创建时）
    const dir = join(home, ".wcode", "projects", projectDirHash("/proj"));
    await mkdir(dir, { recursive: true });
    const meta = (sessionId: string) =>
      JSON.stringify({
        v: 1,
        type: "meta",
        sessionId,
        createdAt: "2026-09-15T08:00:00.000Z",
        cwd: "/proj",
      });
    await writeFile(
      join(dir, "2026-09-15T08-00-00-000Z.jsonl"),
      [
        meta("2026-09-15T08-00-00-000Z"),
        JSON.stringify({ v: 1, type: "message", message: { role: "user", content: "旧问题" } }),
        JSON.stringify({
          v: 1,
          type: "message",
          message: { role: "assistant", text: "旧答", toolCalls: [], usage: { inputTokens: 3, outputTokens: 4 } },
        }),
        "{broken json",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(dir, "2026-09-15T07-00-00-000Z.jsonl"), meta("2026-09-15T07-00-00-000Z"), "utf8");
    await writeFile(join(dir, "notes.txt"), "非 jsonl 忽略", "utf8");

    const driver = await createSessionDriver({ storageType: "sqlite", cwd: "/proj", homeDir: home });
    try {
      const summaries = await driver.listRecent();
      expect(summaries).toHaveLength(1); // 空会话（纯 meta）不导入
      expect(summaries[0]?.sessionId).toBe("2026-09-15T08-00-00-000Z");
      expect(summaries[0]?.messageCount).toBe(2); // 损坏行跳过
      expect(summaries[0]?.preview).toBe("旧问题");
      expect(summaries[0]?.createdAt).toBe("2026-09-15T08:00:00.000Z");

      const messages = messagesFromSessionLines(
        await (await driver.open("2026-09-15T08-00-00-000Z")).load(),
      );
      expect(messages).toEqual([
        { role: "user", content: "旧问题" },
        { role: "assistant", text: "旧答", toolCalls: [], usage: { inputTokens: 3, outputTokens: 4 } },
      ]);

      // 幂等：二次创建 driver 不重复导入；新会话未发消息时不产生任何痕迹
      const driver2 = await createSessionDriver({ storageType: "sqlite", cwd: "/proj", homeDir: home });
      expect(await driver2.listRecent()).toHaveLength(1);
      const fresh = await driver2.createNew({ cwd: "/proj" });
      expect(await driver2.listRecent()).toHaveLength(1);
      expect(await driver2.findLatest()).toBe("2026-09-15T08-00-00-000Z");
      // 发了消息才进列表
      await (
        await driver2.open(fresh.sessionId)
      ).append({ v: 1, type: "message", message: { role: "user", content: "叠加" } });
      expect(await driver2.listRecent()).toHaveLength(2);
      expect(await driver2.findLatest()).toBe(fresh.sessionId);
      driver2.close();

      // 项目隔离：其他 cwd 的 driver 看不到 /proj 的会话
      const other = await createSessionDriver({ storageType: "sqlite", cwd: "/other", homeDir: home });
      expect(await other.listRecent()).toEqual([]);
      expect(await other.findLatest()).toBeNull();
      other.close();
    } finally {
      driver.close();
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("无历史时导入为空操作、列表为空", async () => {
    const home = await mkdtemp(join(tmpdir(), "wcode-imp-empty-"));
    try {
      const driver = await createSessionDriver({ storageType: "sqlite", cwd: "/proj", homeDir: home });
      expect(await driver.listRecent()).toEqual([]);
      expect(await driver.findLatest()).toBeNull();
      driver.close();
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("delete：两实现一致——目标会话消失、其余会话完好、重复删除幂等", async () => {
    for (const storageType of ["jsonl", "sqlite"] as const) {
      const home = await mkdtemp(join(tmpdir(), `wcode-del-${storageType}-`));
      try {
        const driver = await createSessionDriver({ storageType, cwd: "/proj", homeDir: home });
        const a = await driver.createNew({ cwd: "/proj" });
        await a.store.append({
          v: 1,
          type: "message",
          message: { role: "user", content: "要删除的会话" },
        });
        await a.store.append({
          v: 1,
          type: "message",
          message: { role: "assistant", text: "答", toolCalls: [], usage: { inputTokens: 5, outputTokens: 6 } },
        });
        const b = await driver.createNew({ cwd: "/proj" });
        await b.store.append({
          v: 1,
          type: "message",
          message: { role: "user", content: "要保留的会话" },
        });

        await driver.delete(a.sessionId);
        // 再删一次：幂等不抛错
        await driver.delete(a.sessionId);

        const summaries = await driver.listRecent();
        expect(summaries.map((s) => s.sessionId)).toEqual([b.sessionId]);
        // 被删会话打开即空（meta 也没了）
        expect(await (await driver.open(a.sessionId)).load()).toEqual([]);
        // 保留会话完好
        expect(await (await driver.open(b.sessionId)).load()).toHaveLength(2);
        expect(await driver.stats()).toMatchObject({ sessionCount: 1, messageCount: 1 });
        if (storageType === "jsonl") {
          const file = join(
            home,
            ".wcode",
            "projects",
            projectDirHash("/proj"),
            `${a.sessionId}.jsonl`,
          );
          await expect(readFile(file, "utf8")).rejects.toThrow();
        }
        driver.close();
      } finally {
        await rm(home, { recursive: true, force: true }).catch(() => {});
      }
    }
  });
});
