import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPluginManifest, componentPathsToList, normalizeAuthor } from "./manifest";

async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "wcode-plugin-manifest-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}) };
}

describe("findPluginManifest", () => {
  it("解析 .zcode-plugin/plugin.json（推荐位置），版本缺省 0.0.0", async () => {
    const t = await makeTempDir();
    try {
      await mkdir(join(t.dir, ".zcode-plugin"));
      await writeFile(
        join(t.dir, ".zcode-plugin", "plugin.json"),
        JSON.stringify({ name: "hello-world" }),
        "utf8",
      );
      const info = await findPluginManifest(t.dir);
      expect(info).not.toBeNull();
      expect(info?.manifest.name).toBe("hello-world");
      expect(info?.manifest.version).toBe("0.0.0");
      expect(info?.format).toBe("zcode");
    } finally {
      await t.cleanup();
    }
  });

  it("无 .zcode-plugin 时回退 .claude-plugin（Claude Code 插件兼容）", async () => {
    const t = await makeTempDir();
    try {
      await mkdir(join(t.dir, ".claude-plugin"));
      await writeFile(
        join(t.dir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "legacy", version: "1.2.3", skills: "skills" }),
        "utf8",
      );
      const info = await findPluginManifest(t.dir);
      expect(info?.format).toBe("claude");
      expect(info?.manifest.version).toBe("1.2.3");
      expect(info?.manifest.skills).toBe("skills");
    } finally {
      await t.cleanup();
    }
  });

  it("非法清单（名字不合规则）抛出教学式错误", async () => {
    const t = await makeTempDir();
    try {
      await mkdir(join(t.dir, ".zcode-plugin"));
      await writeFile(
        join(t.dir, ".zcode-plugin", "plugin.json"),
        JSON.stringify({ name: "Bad Name!" }),
        "utf8",
      );
      await expect(findPluginManifest(t.dir)).rejects.toThrow(/name/);
    } finally {
      await t.cleanup();
    }
  });

  it("没有清单的目录返回 null（常态，不算错误）", async () => {
    const t = await makeTempDir();
    try {
      expect(await findPluginManifest(t.dir)).toBeNull();
    } finally {
      await t.cleanup();
    }
  });
});

describe("manifest 工具函数", () => {
  it("componentPathsToList：字符串单目录与数组都归一为数组", () => {
    expect(componentPathsToList(undefined)).toEqual([]);
    expect(componentPathsToList("skills")).toEqual(["skills"]);
    expect(componentPathsToList(["a", "b"])).toEqual(["a", "b"]);
  });

  it("normalizeAuthor：字符串与对象统一为对象", () => {
    expect(normalizeAuthor("Z.ai")).toEqual({ name: "Z.ai" });
    expect(normalizeAuthor({ name: "Z.ai", url: "https://z.ai" })).toEqual({
      name: "Z.ai",
      url: "https://z.ai",
    });
    expect(normalizeAuthor(undefined)).toBeUndefined();
  });
});
