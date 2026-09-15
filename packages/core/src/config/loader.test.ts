import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./loader";
import { ConfigError } from "../errors";

async function withTempDirs(
  userJson: string | null,
  projectJson: string | null,
): Promise<{ homeDir: string; cwd: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "wcode-config-"));
  const homeDir = join(base, "home");
  const cwd = join(base, "proj");
  await mkdir(join(homeDir), { recursive: true });
  await mkdir(join(cwd, ".wcode"), { recursive: true });
  if (userJson !== null) {
    await writeFile(join(homeDir, "settings.json"), userJson, "utf8");
  }
  if (projectJson !== null) {
    await writeFile(join(cwd, ".wcode", "settings.json"), projectJson, "utf8");
  }
  return {
    homeDir,
    cwd,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

describe("loadConfig 分层合并", () => {
  it("无任何配置文件时返回完整默认值", async () => {
    const t = await withTempDirs(null, null);
    try {
      const cfg = await loadConfig({ homeDir: t.homeDir, cwd: t.cwd });
      expect(cfg.activeProvider).toBe("anthropic");
      expect(cfg.model).toBe("claude-sonnet-4-5");
      expect(cfg.permissions.mode).toBe("default");
      expect(cfg.tools.maxOutputChars).toBe(30_000);
      expect(cfg.providers.anthropic?.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    } finally {
      await t.cleanup();
    }
  });

  it("项目级覆盖全局，全局覆盖默认", async () => {
    const t = await withTempDirs(
      JSON.stringify({ model: "user-model", log: { level: "debug" } }),
      JSON.stringify({ model: "project-model" }),
    );
    try {
      const cfg = await loadConfig({ homeDir: t.homeDir, cwd: t.cwd });
      expect(cfg.model).toBe("project-model");
      expect(cfg.log.level).toBe("debug"); // 未被项目层触碰的字段保留
    } finally {
      await t.cleanup();
    }
  });

  it("overrides（CLI 参数）优先级最高", async () => {
    const t = await withTempDirs(JSON.stringify({ model: "user-model" }), null);
    try {
      const cfg = await loadConfig({
        homeDir: t.homeDir,
        cwd: t.cwd,
        overrides: { model: "cli-model" },
      });
      expect(cfg.model).toBe("cli-model");
    } finally {
      await t.cleanup();
    }
  });

  it("JSON 语法错误报出文件路径", async () => {
    const t = await withTempDirs("{ not json", null);
    try {
      await expect(loadConfig({ homeDir: t.homeDir, cwd: t.cwd })).rejects.toThrow(
        ConfigError,
      );
      await expect(loadConfig({ homeDir: t.homeDir, cwd: t.cwd })).rejects.toThrow(
        /settings\.json/,
      );
    } finally {
      await t.cleanup();
    }
  });

  it("字段类型错误给出友好字段定位", async () => {
    const t = await withTempDirs(
      JSON.stringify({ permissions: { mode: "yolo" } }),
      null,
    );
    try {
      const err = await loadConfig({ homeDir: t.homeDir, cwd: t.cwd }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain("permissions.mode");
    } finally {
      await t.cleanup();
    }
  });
});
