import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionDriver, type SessionDriver } from "./driver";
import { openSqliteDb, SqliteSessionStore } from "./sqlite-store";
import { runMigrations } from "./migrations";
import { JsonlSessionStore, type SessionLine } from "./store";

/** 同一操作序列跑两种实现，输出可对比的结果（契约对拍，设计 §8） */
async function runScenario(driver: SessionDriver): Promise<{
  summaries: Awaited<ReturnType<SessionDriver["listRecent"]>>;
  latest: string | null;
  loaded1: SessionLine[];
  loaded2: SessionLine[];
  ids: string[];
}> {
  const cwd = "/proj";
  const s1 = await driver.createNew({ cwd });
  await s1.store.append({
    v: 1,
    type: "message",
    message: { role: "user", content: "你好  世界" },
  });
  await s1.store.append({
    v: 1,
    type: "message",
    message: {
      role: "assistant",
      text: "答一",
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5 },
    },
  });
  // 同毫秒内 message→event→message 混合追加：回放序必须等于插入序
  await s1.store.append({ v: 1, type: "event", event: { type: "compacted", note: "n1" } });
  await s1.store.append({
    v: 1,
    type: "message",
    message: {
      role: "tool_result",
      results: [{ callId: "c1", content: "工具输出", isError: false }],
    },
  });

  const s2 = await driver.createNew({ cwd });
  await s2.store.append({
    v: 1,
    type: "message",
    message: { role: "user", content: "帮我修复登录 bug" },
  });

  return {
    summaries: await driver.listRecent(),
    latest: await driver.findLatest(),
    loaded1: await (await driver.open(s1.sessionId)).load(),
    loaded2: await s2.store.load(),
    ids: [s1.sessionId, s2.sessionId],
  };
}

const dropMeta = (lines: SessionLine[]): SessionLine[] =>
  lines.filter((l) => l.type !== "meta");

describe("存储契约对拍（jsonl vs sqlite）", () => {
  it("roundtrip / 列表 / latest 两实现一致", async () => {
    const jsonlHome = await mkdtemp(join(tmpdir(), "wcode-cmp-j-"));
    const sqliteHome = await mkdtemp(join(tmpdir(), "wcode-cmp-s-"));
    const jd = await createSessionDriver({ storageType: "jsonl", cwd: "/proj", homeDir: jsonlHome });
    const sd = await createSessionDriver({ storageType: "sqlite", cwd: "/proj", homeDir: sqliteHome });
    try {
      const j = await runScenario(jd);
      const s = await runScenario(sd);

      // 消息/事件行完全一致（payload 权威）
      expect(dropMeta(s.loaded1)).toEqual(dropMeta(j.loaded1));
      expect(dropMeta(s.loaded2)).toEqual(dropMeta(j.loaded2));
      // meta 行语义一致（id/cwd 相同，createdAt 均为 ISO）
      const meta1 = s.loaded1[0];
      const meta2 = s.loaded2[0];
      expect(meta1).toMatchObject({ type: "meta", sessionId: s.ids[0], cwd: "/proj" });
      expect(meta1 && meta1.type === "meta" && meta1.createdAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T/,
      );
      expect(meta2).toMatchObject({ type: "meta", sessionId: s.ids[1], cwd: "/proj" });

      // 列表：新→旧、消息数、预览（空白折叠）一致
      expect(s.summaries.map((x) => [x.messageCount, x.preview])).toEqual(
        j.summaries.map((x) => [x.messageCount, x.preview]),
      );
      expect(s.summaries[0]?.sessionId).toBe(s.ids[1]);
      expect(s.summaries[0]?.messageCount).toBe(1);
      expect(s.summaries[0]?.preview).toBe("帮我修复登录 bug");
      expect(s.summaries[1]?.preview).toBe("你好 世界"); // 连续空白折叠，与 jsonl 同规则
      expect(s.summaries[1]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // --continue 语义一致
      expect(s.latest).toBe(s.ids[1]);
      expect(j.latest).toBe(j.ids[1]);
    } finally {
      jd.close();
      sd.close();
      await rm(jsonlHome, { recursive: true, force: true }).catch(() => {});
      await rm(sqliteHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("恢复后继续追加落在同一会话（/resume 写入路径）", async () => {
    const home = await mkdtemp(join(tmpdir(), "wcode-cmp-r-"));
    const driver = await createSessionDriver({ storageType: "sqlite", cwd: "/proj", homeDir: home });
    try {
      const driver = await createSessionDriver({ storageType: "sqlite", cwd: "/proj", homeDir: home });
      const first = await driver.createNew({ cwd: "/proj" });
      await first.store.append({
        v: 1,
        type: "message",
        message: { role: "user", content: "第一问" },
      });

      const resumed = await driver.open(first.sessionId);
      await resumed.append({
        v: 1,
        type: "message",
        message: { role: "user", content: "接着问" },
      });
      const messages = dropMeta(await resumed.load());
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ type: "message" });
      expect(messages[1]).toMatchObject({ type: "message" });

      const summaries = await driver.listRecent();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.messageCount).toBe(2); // 追加计入同一会话
      expect(summaries[0]?.preview).toBe("第一问"); // title 只取首条用户消息
    } finally {
      driver.close();
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("SqliteSessionStore", () => {
  it("损坏 payload 行跳过不阻塞恢复（与 jsonl 同容错语义）", async () => {
    const db = await openSqliteDb(":memory:");
    db.prepare(
      "INSERT INTO sessions (id, project_hash, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("s1", "h", "/x", 1, 1);
    const insert = db.prepare(
      "INSERT INTO messages (session_id, idx, role, text, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("s1", 0, "user", "好", JSON.stringify({ role: "user", content: "好" }), 1);
    insert.run("s1", 1, "assistant", null, "{broken json", 2);

    const store = new SqliteSessionStore({ db, sessionId: "s1", projectHash: "h", cwd: "/x" });
    const messages = dropMeta(await store.load());
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "message" });
  });

  it("迁移幂等：openSqliteDb 已应用后 runMigrations 返回空", async () => {
    const db = await openSqliteDb(":memory:");
    expect(runMigrations(db)).toEqual([]);
  });
});
