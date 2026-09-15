import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "./store";

describe("JsonlSessionStore", () => {
  it("append + load 往返", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-store-"));
    try {
      const p = join(dir, "s1.jsonl");
      const store = new JsonlSessionStore(p);
      await store.append({ v: 1, type: "meta", sessionId: "s1", createdAt: "t", cwd: "/x" });
      await store.append({ v: 1, type: "message", message: { role: "user", content: "hi" } });
      const loaded = await store.load();
      expect(loaded).toHaveLength(2);
      expect(loaded[1]?.type).toBe("message");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("损坏行跳过不阻塞恢复", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcode-store-"));
    try {
      const p = join(dir, "s1.jsonl");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        p,
        '{"v":1,"type":"message","message":{"role":"user","content":"ok"}}\n{{{\n',
        "utf8",
      );
      const store = new JsonlSessionStore(p);
      const loaded = await store.load();
      expect(loaded).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
