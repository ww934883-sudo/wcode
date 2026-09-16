import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "./store";
import { messagesFromSessionLines } from "./resume";
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

  it("findLatest 按文件名（时间戳）取最新；目录不存在返回 null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-resume-"));
    try {
      const probe = new JsonlSessionStore(join(dir, "probe.jsonl"));
      await writeFile(join(dir, "2026-09-15T10-00-00-000Z.jsonl"), "{}\n", "utf8");
      await writeFile(join(dir, "2026-09-15T11-00-00-000Z.jsonl"), "{}\n", "utf8");
      expect(await probe.findLatest()).toBe("2026-09-15T11-00-00-000Z");
      const missing = new JsonlSessionStore(join(dir, "none", "probe.jsonl"));
      expect(await missing.findLatest()).toBeNull();
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

const metaLine = (sessionId: string) =>
  JSON.stringify({ v: 1, type: "meta", sessionId, createdAt: "2026-09-15T10:00:00.000Z", cwd: "/x" });
const userLine = (content: string) =>
  JSON.stringify({ v: 1, type: "message", message: { role: "user", content } });
const assistantLine = (text: string) =>
  JSON.stringify({
    v: 1,
    type: "message",
    message: { role: "assistant", text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
  });

describe("listRecent（/resume 列表，jsonl 目录扫描实现）", () => {
  it("按新→旧列出，解析消息数、meta 与首条用户消息预览", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-resume-list-"));
    try {
      await writeFile(
        join(dir, "2026-09-15T08-00-00-000Z.jsonl"),
        [metaLine("a"), userLine("旧会话的问题"), assistantLine("答")].join("\n"),
        "utf8",
      );
      await writeFile(
        join(dir, "2026-09-15T14-00-00-000Z.jsonl"),
        [metaLine("b"), userLine("帮我修复登录  bug，急"), assistantLine("好")].join("\n"),
        "utf8",
      );
      await writeFile(join(dir, "notes.txt"), "非 jsonl 忽略", "utf8");

      const probe = new JsonlSessionStore(join(dir, "probe.jsonl"));
      const sessions = await probe.listRecent();
      expect(sessions).toHaveLength(2);
      expect(sessions[0]?.sessionId).toBe("2026-09-15T14-00-00-000Z"); // 新的在前
      expect(sessions[0]?.messageCount).toBe(2);
      expect(sessions[0]?.preview).toBe("帮我修复登录 bug，急"); // 连续空白折叠
      expect(sessions[0]?.createdAt).toBe("2026-09-15T10:00:00.000Z");
      expect(sessions[1]?.sessionId).toBe("2026-09-15T08-00-00-000Z");
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
    }
  });

  it("limit 截断；损坏行跳过；目录不存在返回空", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-resume-list-"));
    try {
      // 时间戳文件名：08 的更新（含损坏行），07 的为空文件
      await writeFile(
        join(dir, "2026-09-15T08-00-00-000Z.jsonl"),
        [metaLine("a"), "{broken json", userLine("问题")].join("\n"),
        "utf8",
      );
      await writeFile(join(dir, "2026-09-15T07-00-00-000Z.jsonl"), "", "utf8");
      const probe = new JsonlSessionStore(join(dir, "probe.jsonl"));
      const sessions = await probe.listRecent(1);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.messageCount).toBe(1); // 损坏行跳过
      const missing = new JsonlSessionStore(join(dir, "nope", "probe.jsonl"));
      expect(await missing.listRecent()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
    }
  });
});
