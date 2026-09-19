import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { copyTree, rmTree, readSeed, writeSeed } from "./install";
import { findPluginManifest } from "./manifest";
import { errorMessage } from "../errors";

/**
 * 内置插件（对齐 zcode 内置官方插件语义）：
 *   - 随应用分发的插件包放在仓库 plugins-builtin/<名>/ 下（打包即携带）
 *   - 启动时"播种"到本机缓存 cache/wcode-builtin/<名>/<版本>/，默认启用
 *   - 版本升级后重播种（旧版本目录清理）；用户卸载过的（blockedBuiltins）不装回
 */
export const BUILTIN_MARKET_ID = "wcode-builtin";

export interface SeedBuiltinResult {
  /** 本次新装/升级的内置插件 */
  seeded: string[];
  /** 已是最新，跳过 */
  skipped: string[];
  /** 被用户卸载屏蔽，不装回 */
  blocked: string[];
  problems: string[];
}

/**
 * 把 builtinDir 下的插件播种到 pluginsDir（cache/wcode-builtin/...）。
 * builtinDir 不存在视为无内置插件（常态，不报问题）。
 */
export async function seedBuiltinPlugins(opts: {
  pluginsDir: string;
  builtinDir: string;
  /** 用户卸载过的内置插件名单（config.plugins.blockedBuiltins） */
  blockedBuiltins?: string[];
}): Promise<SeedBuiltinResult> {
  const result: SeedBuiltinResult = { seeded: [], skipped: [], blocked: [], problems: [] };
  let entries;
  try {
    entries = await readdir(opts.builtinDir, { withFileTypes: true });
  } catch {
    return result;
  }
  const blocked = new Set(opts.blockedBuiltins ?? []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const src = join(opts.builtinDir, entry.name);
    let info;
    try {
      info = await findPluginManifest(src);
    } catch (err) {
      result.problems.push(`内置插件 ${entry.name} 清单不合法: ${errorMessage(err)}`);
      continue;
    }
    if (!info) {
      result.problems.push(`内置插件 ${entry.name} 缺少 plugin.json，已跳过`);
      continue;
    }
    const name = info.manifest.name;
    if (blocked.has(name)) {
      result.blocked.push(name);
      continue;
    }
    const dest = join(opts.pluginsDir, "cache", BUILTIN_MARKET_ID, name, info.manifest.version);
    // 已播种且版本一致则跳过（幂等，启动开销为零拷贝）
    const existing = await readSeed(dest);
    if (existing && existing.pluginVersion === info.manifest.version) {
      result.skipped.push(name);
      continue;
    }
    try {
      await copyTree(src, dest);
      // 清理旧版本目录，cache 只保留当前版本
      await pruneOtherVersions(opts.pluginsDir, name, info.manifest.version);
      await writeSeed(dest, {
        version: 1,
        marketplace: BUILTIN_MARKET_ID,
        plugin: name,
        pluginVersion: info.manifest.version,
        source: "builtin",
        hash: "",
      });
      result.seeded.push(name);
    } catch (err) {
      result.problems.push(`内置插件 ${name} 播种失败: ${errorMessage(err)}`);
    }
  }
  return result;
}

async function pruneOtherVersions(
  pluginsDir: string,
  pluginName: string,
  keepVersion: string,
): Promise<void> {
  const pluginDir = join(pluginsDir, "cache", BUILTIN_MARKET_ID, pluginName);
  let dirs;
  try {
    dirs = await readdir(pluginDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name === keepVersion) continue;
    await rmTree(join(pluginDir, d.name));
  }
}
