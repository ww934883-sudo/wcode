import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configSchema, type WcodeConfig } from "./schema";
import { ConfigError, errorMessage } from "../errors";

export interface LoadConfigOptions {
  /** CLI 参数层（最高优先级） */
  overrides?: Record<string, unknown>;
  /** 工作目录（项目级配置查找位置），默认 process.cwd() */
  cwd?: string;
  /** 全局目录，默认 ~/.wcode（测试注入） */
  homeDir?: string;
}

/**
 * 分层合并（架构文档 §4.1）：
 *   内置默认 < ~/.wcode/settings.json < <cwd>/.wcode/settings.json < CLI overrides
 * 任何配置错误都必须给出「哪个文件、哪个字段、期望什么」，退出码 2。
 */
export async function loadConfig(
  opts: LoadConfigOptions = {},
): Promise<WcodeConfig> {
  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir ?? join(homedir(), ".wcode");

  const userFile = join(homeDir, "settings.json");
  const projectFile = join(cwd, ".wcode", "settings.json");

  let merged: Record<string, unknown> = {};
  merged = mergeLayer(merged, await readLayer(userFile));
  merged = mergeLayer(merged, await readLayer(projectFile));
  if (opts.overrides) {
    merged = mergeLayer(merged, opts.overrides);
  }

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `  - 字段 ${i.path.join(".") || "(根)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(
      `配置不合法（检查 ~/.wcode/settings.json 或 .wcode/settings.json）:\n${issues}`,
    );
  }
  return parsed.data;
}

async function readLayer(file: string): Promise<Record<string, unknown>> {
  if (!existsSync(file)) return {};
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    throw new ConfigError(`配置文件不可读: ${file}: ${errorMessage(err)}`);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("顶层必须是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(`配置文件 JSON 解析失败: ${file}: ${errorMessage(err)}`);
  }
}

/** 深合并：普通对象递归合并，数组与原始值直接替换 */
function mergeLayer(
  base: Record<string, unknown>,
  layer: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    const current = out[key];
    if (
      isPlainObject(current) &&
      isPlainObject(value)
    ) {
      out[key] = mergeLayer(current, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
