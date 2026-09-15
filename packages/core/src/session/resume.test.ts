import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "./store";
import { findLatestSessionFile, messagesFromSessionLines } from "./resume";
import { AgentSession } from "../loop/agent-session";
import { ToolRegistry, sourceOf } from "../tools/registry";
import { readTool } from "../tools/builtin/read";
import { PermissionEngine } from "../permission/engine";
import { FakeProvider, endTurn } from "../testing/fake-provider";
import { RecordingHost } from "../testing/fixtures";

describe("会话恢复", () => {
  it("messagesFromSessionLines 重放消息（跳过 meta/event 行）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-resume-"));
    try {
      const store = new JsonlSessionStore(join(dir, "s1.jsonl"));
      await store.append({ v: 1, type: "meta", sessionId: "s1", createdAt: "t", cwd: "/x" });
      await store.append({ v: 1, type: "message", message: { role: "user", content: "第一问" } });
      await store.append({
        v: 1,
        type: "message",
        message: { role: "assistant", text: "第一答", toolCalls: [] },
      });
      await store.append({ v: 1, type: "event", event: { type: "compacted", note: "n" } });
      const messages = messagesFromSessionLines(await store.load());
      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({ role: "user", content: "第一问" });
      expect(messages[1]).toEqual({ role: "assistant", text: "第一答", toolCalls: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("findLatestSessionFile 按文件名（时间戳）取最新", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-resume-"));
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(dir, "2026-09-15T10-00-00-000Z.jsonl"), "{}\n", "utf8");
      await writeFile(join(dir, "2026-09-15T11-00-00-000Z.jsonl"), "{}\n", "utf8");
      const latest = await findLatestSessionFile(dir);
      expect(latest?.endsWith("2026-09-15T11-00-00-000Z.jsonl")).toBe(true);
      expect(await findLatestSessionFile(join(dir, "none"))).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("initialMessages 注入后模型可见历史上下文", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-resume-"));
    try {
      const provider = new FakeProvider([{ response: endTurn("continue-ok") }]);
      const registry = new ToolRegistry();
      await registry.registerSource(sourceOf("builtin", [readTool]));
      const session = new AgentSession({
        provider,
        registry,
        host: new RecordingHost(),
        engine: new PermissionEngine(),
        system: "sys",
        cwd: dir,
        retryDelaysMs: [1],
        initialMessages: [
          { role: "user", content: "之前的问题" },
          { role: "assistant", text: "之前的回答", toolCalls: [] },
        ],
      });
      const result = await session.run("继续");
      expect(result.reply).toBe("continue-ok");
      // 首个请求携带恢复的历史 + 新输入
      const first = provider.requests[0]!.messages;
      expect(first[0]).toEqual({ role: "user", content: "之前的问题" });
      expect(first[2]).toEqual({ role: "user", content: "继续" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
