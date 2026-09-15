import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHooks } from "./hooks";
import { configSchema } from "../config/schema";

// hook 命令统一用 node -e（shell:true → Windows 是 cmd /c，Unix 是 /bin/sh），
// JS 内只用单引号，避免 cmd 引号转义问题
async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "wcode-hooks-"));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {}),
  };
}

const hooksCfg = (partial: Record<string, unknown>) =>
  configSchema.parse({ hooks: partial }).hooks;

describe("runHooks", () => {
  it("退出码 0 放行，且 stdin 收到可解析的 JSON payload", async () => {
    const t = await makeTempDir();
    try {
      // hook 解析 stdin JSON：字段对上写 payload-ok.txt，否则写 payload-bad.txt
      const cfg = hooksCfg({
        preToolUse: [
          {
            command:
              "node -e \"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s);const ok=j.toolName==='read'&&j.toolInput.file_path==='a.ts'&&j.event==='pre_tool_use'&&typeof j.cwd==='string';require('fs').writeFileSync(ok?'payload-ok.txt':'payload-bad.txt','x');process.exit(0)})\"",
          },
        ],
      });
      const outcome = await runHooks(
        "pre_tool_use",
        cfg,
        { toolName: "read", toolInput: { file_path: "a.ts" } },
        { cwd: t.dir },
      );
      expect(outcome.blocked).toBeUndefined();
      expect(outcome.notices).toEqual([]);
      expect(await readFile(join(t.dir, "payload-ok.txt"), "utf8")).toBe("x");
    } finally {
      await t.cleanup();
    }
  });

  it("退出码 2 阻断（pre_tool_use）；post 事件中同样退出码只记 notice", async () => {
    const t = await makeTempDir();
    try {
      const pre = hooksCfg({
        preToolUse: [
          { command: "node -e \"console.error('禁止删除公共文件');process.exit(2)\"" },
        ],
      });
      const preOut = await runHooks("pre_tool_use", pre, { toolName: "write" }, { cwd: t.dir });
      expect(preOut.blocked).toBe("禁止删除公共文件");
      // post 事件中退出码 2 不阻断，只记 notice
      const post = hooksCfg({
        postToolUse: [
          { command: "node -e \"console.error('禁止删除公共文件');process.exit(2)\"" },
        ],
      });
      const postOut = await runHooks("post_tool_use", post, { toolName: "write" }, { cwd: t.dir });
      expect(postOut.blocked).toBeUndefined();
      expect(postOut.notices).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });

  it("matcher 过滤工具名（正则）；未匹配的 hook 不执行", async () => {
    const t = await makeTempDir();
    try {
      const marker = join(t.dir, "marker.txt");
      const cfg = hooksCfg({
        preToolUse: [
          { matcher: "write|edit", command: `node -e "require('fs').writeFileSync('marker.txt','hit')"` },
        ],
      });
      await runHooks("pre_tool_use", cfg, { toolName: "read" }, { cwd: t.dir });
      await expect(readFile(marker, "utf8")).rejects.toThrow(); // 未执行
      await runHooks("pre_tool_use", cfg, { toolName: "write" }, { cwd: t.dir });
      expect(await readFile(marker, "utf8")).toBe("hit"); // 已执行
    } finally {
      await t.cleanup();
    }
  });

  it("非 0 非 2 退出码 → 非致命 notice，不阻断", async () => {
    const t = await makeTempDir();
    try {
      const cfg = hooksCfg({
        preToolUse: [{ command: "node -e \"console.log('警告内容');process.exit(1)\"" }],
      });
      const outcome = await runHooks("pre_tool_use", cfg, { toolName: "read" }, { cwd: t.dir });
      expect(outcome.blocked).toBeUndefined();
      expect(outcome.notices).toHaveLength(1);
      expect(outcome.notices[0]).toContain("退出码 1");
      expect(outcome.notices[0]).toContain("警告内容");
    } finally {
      await t.cleanup();
    }
  });

  it("hook 超时被终止并记 notice", async () => {
    const t = await makeTempDir();
    try {
      const cfg = hooksCfg({
        timeoutMs: 300,
        preToolUse: [{ command: "node -e \"setTimeout(function(){},60000)\"" }],
      });
      const outcome = await runHooks("pre_tool_use", cfg, { toolName: "read" }, { cwd: t.dir });
      expect(outcome.blocked).toBeUndefined();
      expect(outcome.notices).toHaveLength(1);
      expect(outcome.notices[0]).toContain("超时");
    } finally {
      await t.cleanup();
    }
  }, 15_000);

  it("session_start 事件执行且不做 matcher 过滤", async () => {
    const t = await makeTempDir();
    try {
      const cfg = hooksCfg({
        sessionStart: [{ matcher: "不可能匹配", command: `node -e "require('fs').writeFileSync('started.txt','ok')"` }],
      });
      const outcome = await runHooks("session_start", cfg, {}, { cwd: t.dir });
      expect(outcome.notices).toEqual([]);
      expect(await readFile(join(t.dir, "started.txt"), "utf8")).toBe("ok");
    } finally {
      await t.cleanup();
    }
  });

  it("非法 matcher 正则记 notice 并跳过该 hook（不猜意图）", async () => {
    const t = await makeTempDir();
    try {
      const cfg = hooksCfg({
        preToolUse: [
          { matcher: "wri(te", command: `node -e "require('fs').writeFileSync('sub.txt','ok')"` },
        ],
      });
      const outcome = await runHooks("pre_tool_use", cfg, { toolName: "write" }, { cwd: t.dir });
      expect(outcome.blocked).toBeUndefined();
      expect(outcome.notices).toHaveLength(1);
      expect(outcome.notices[0]).toContain("不是合法正则");
      await expect(readFile(join(t.dir, "sub.txt"), "utf8")).rejects.toThrow(); // 未执行
    } finally {
      await t.cleanup();
    }
  });
});
