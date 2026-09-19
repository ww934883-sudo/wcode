import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  describeSource,
  loadKnownMarketplaces,
  readMarketplaceJson,
  saveKnownMarketplaces,
  normalizeKnownSource,
  parseMarketplaceSource,
  type KnownMarketplace,
  type KnownMarketplacesFile,
  type MarketplaceJson,
  type MarketplacePluginEntry,
  type MarketplaceSource,
} from "./marketplace";
import { findPluginManifest, type PluginManifest } from "./manifest";
import { errorMessage } from "../errors";

/**
 * 插件安装布局（对齐 zcode）：
 *   <pluginsDir>/marketplaces/<市场id>/          市场内容物化（clone/拷贝）
 *   <pluginsDir>/cache/<市场>/<插件>/<版本>/      已安装插件（安装即快照）
 *   <插件根>/.wcode-plugin-seed.json             安装凭据（市场/版本/来源）
 */

export class PluginError extends Error {}

export interface InstallTarget {
  root: string;
  version: string;
  manifest: PluginManifest;
  /** 依赖插件的安装问题（非致命，主插件已就位） */
  problems: string[];
}

/** seed 文件（安装凭据；发现层据此确认插件来自哪个市场） */
export interface PluginSeed {
  version: 1;
  marketplace: string;
  plugin: string;
  pluginVersion: string;
  source: string;
  hash: string;
}

/** git 子进程缺省超时：浅克隆大仓库也要给足余量 */
const GIT_TIMEOUT_MS = 180_000;
/** 进程被杀后 Windows 孤儿可能仍持有 stderr 管道，宽限期后强制结算 */
const GIT_SETTLE_MS = 1_500;

/** 提取 stderr 里可行动的原因行：开头几行是 "Cloning into ..." 进度行，真原因在末尾 */
function gitErrorReason(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l !== "" &&
        !/^Cloning into/.test(l) &&
        !/^remote:?( ?(Counting|Compressing|Enumerating|Receiving|Resolving|finding|done))/i.test(l),
    );
  return lines.slice(-3).join("；") || "（git 未输出原因）";
}

/** 失败原因 → 可行动提示（网络 / 权限与存在性 各自给法子） */
function gitFailureHint(stderr: string): string {
  if (/unable to access|failed to connect|connection|timed out|could not resolve|ssl|certificate/i.test(stderr)) {
    return "。看起来是网络问题：git 会自动使用 HTTPS_PROXY/HTTP_PROXY 环境变量，配置后重试；" +
      "也可先手动把仓库克隆到本地，再用本地目录作为市场来源";
  }
  // 权限不足与仓库/路径不存在在 git 输出里经常是同一句话（Could not read from remote repository）
  if (/authentication|403|permission denied|could not read from remote|not found|does not exist|not a (git )?repository/i.test(stderr)) {
    return "。请确认仓库/路径存在且拼写正确；私有仓库可改用 SSH url（git@github.com:owner/repo.git）";
  }
  return "";
}

function runGit(args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let grace: ReturnType<typeof setTimeout> | undefined;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      fn();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      grace = setTimeout(
        () =>
          settle(() =>
            reject(
              new PluginError(
                `git 超时（${Math.round(timeoutMs / 1000)}s）：git ${args.join(" ")}。` +
                  "网络不佳时可重试，或先手动克隆到本地、用本地目录作为来源",
              ),
            ),
          ),
        GIT_SETTLE_MS,
      );
    }, timeoutMs);

    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 8000) stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      settle(() =>
        reject(new PluginError(`执行 git 失败（${err.message}）。请确认 git 已安装并在 PATH 中。`)),
      );
    });
    child.on("close", (code) => {
      settle(() => {
        if (timedOut) {
          reject(
            new PluginError(
              `git 超时（${Math.round(timeoutMs / 1000)}s）：git ${args.join(" ")}。` +
                "网络不佳时可重试，或先手动克隆到本地、用本地目录作为来源",
            ),
          );
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new PluginError(
            `git ${args[0] ?? ""} 失败（退出码 ${code ?? "unknown"}）：` +
              `${gitErrorReason(stderr)}${gitFailureHint(stderr)}`,
          ),
        );
      });
    });
  });
}

export async function copyTree(src: string, dest: string): Promise<void> {
  await cp(src, dest, { recursive: true, force: true, errorOnExist: false });
}

/** 下载超时与解压超时（zip 包一般几 MB） */
const DOWNLOAD_TIMEOUT_MS = 120_000;
const EXTRACT_TIMEOUT_MS = 60_000;

/**
 * 下载文件到本地（可选 sha256 校验）。zcode 官方市场以带 sha256 的 zip 分发插件，
 * 校验失败要报清期望值与实际值。
 */
async function downloadFile(
  url: string,
  headers: Record<string, string> | undefined,
  destFile: string,
  sha256?: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = errorMessage(err);
    throw new PluginError(
      `下载失败: ${msg}（${url}）。请检查网络/代理；也可先手动下载到本地，改用 directory/file 来源`,
    );
  }
  if (!res.ok) {
    throw new PluginError(`下载失败：HTTP ${res.status}（${url}）`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256) {
    const actual = createHash("sha256").update(buf).digest("hex");
    if (actual.toLowerCase() !== sha256.toLowerCase()) {
      throw new PluginError(
        `下载内容 sha256 校验失败（期望 ${sha256}，实际 ${actual}）。来源可能被篡改或版本已更新，刷新市场后重试`,
      );
    }
  }
  await writeFile(destFile, buf);
}

/** zip 解压：Windows 用 PowerShell Expand-Archive，POSIX 用 unzip（都不经 shell 拼接，参数数组注入安全） */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "powershell" : "unzip";
  const args = isWin
    ? [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destDir}" -Force`,
      ]
    : ["-o", zipPath, "-d", destDir];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString("utf8");
    });
    const timer = setTimeout(() => child.kill(), EXTRACT_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new PluginError(
          isWin
            ? `解压失败（${err.message}）：未找到 powershell`
            : `解压失败（${err.message}）：未找到 unzip 命令`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new PluginError(
            `解压 zip 失败（退出码 ${code ?? "unknown"}）：${stderr.trim().split(/\r?\n/).slice(-2).join("；") || "无输出"}`,
          ),
        );
    });
  });
}

export async function rmTree(dir: string): Promise<void> {
  // Windows：资源管理器/杀毒可能短暂占用，maxRetries 兜底 EBUSY/EPERM
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
}

/** 版本号比较：按 "." 分段数值比较，非数字段按字符串兜底 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    const sa = pa[i] ?? "";
    const sb = pb[i] ?? "";
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  return 0;
}

function tempDir(pluginsDir: string, tag: string): string {
  return join(pluginsDir, "marketplaces", `.tmp-${tag}-${Date.now().toString(36)}`);
}

/**
 * 把市场/插件来源物化到 dest：
 *   github/git → 浅克隆（ref → --branch）；directory/file/url → 拷贝/下载
 */
async function materializeSource(
  source: MarketplaceSource,
  dest: string,
  opts: { cwd: string },
): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  if (typeof source === "string") {
    // marketplace.json 里的相对路径：相对市场根（调用方已确保传入的是市场根下的绝对路径）
    await copyTree(source, dest);
    return;
  }
  switch (source.source) {
    case "github": {
      const repo = source.repo ?? "";
      if (!/^[\w.-]+\/[\w.-]+/.test(repo)) {
        throw new PluginError(`github 来源 "${repo}" 不合法，应为 owner/repo`);
      }
      const url = `https://github.com/${repo}.git`;
      const args = ["clone", "--depth", "1"];
      if (source.ref) args.push("--branch", source.ref);
      args.push(url, dest);
      await runGit(args);
      return;
    }
    case "git": {
      if (!source.url) throw new PluginError("git 来源缺少 url");
      const args = ["clone", "--depth", "1"];
      if (source.ref) args.push("--branch", source.ref);
      args.push(source.url, dest);
      await runGit(args);
      return;
    }
    case "directory":
    case "file": {
      const p = source.path ?? "";
      const abs = /^([a-zA-Z]:[\\/]|\/)/.test(p) ? p : join(opts.cwd, p);
      if (source.source === "file") {
        await mkdir(dest, { recursive: true });
        await cp(abs, join(dest, "marketplace.json"), { force: true });
        return;
      }
      await copyTree(abs, dest);
      return;
    }
    case "url": {
      if (!source.url) throw new PluginError("url 来源缺少 url");
      // zip 分发（zcode 官方市场形态）：下载 → sha256 校验 → 解压，目录里应含 marketplace.json
      if (source.type === "zip" || source.url.toLowerCase().endsWith(".zip")) {
        const zipFile = join(dest, ".download.zip");
        await downloadFile(source.url, source.headers, zipFile, source.sha256);
        await extractZip(zipFile, dest);
        await rm(zipFile, { force: true, maxRetries: 3, retryDelay: 150 });
        return;
      }
      let res: Response;
      try {
        res = await fetch(source.url, {
          headers: source.headers as Record<string, string> | undefined,
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
      } catch (err) {
        throw new PluginError(`下载市场清单失败: ${errorMessage(err)}`);
      }
      if (!res.ok) {
        throw new PluginError(`下载市场清单失败：HTTP ${res.status}（${source.url}）`);
      }
      const text = await res.text();
      await mkdir(dest, { recursive: true });
      await writeFile(join(dest, "marketplace.json"), text, "utf8");
      return;
    }
    case "npm":
      throw new PluginError(
        `暂不支持 npm 来源（${source.package ?? ""}）。可先 npm pack/publish 到本地，` +
          "用 directory/file 或 github/git 来源添加市场。",
      );
  }
}

/** 市场内容基目录：file 来源的清单是外部文件，插件相对路径相对其原目录解析 */
function marketplaceBaseDir(known: KnownMarketplace, materializedDir: string): string {
  if (typeof known.source !== "string" && known.source.source === "file") {
    const p = known.source.path ?? "";
    return /^([a-zA-Z]:[\\/]|\/)/.test(p) ? dirname(p) : p;
  }
  return materializedDir;
}

/** 添加市场：物化 → 读 marketplace.json → 以其 name 为 id 登记 */
export async function addMarketplace(opts: {
  input: string;
  pluginsDir: string;
  cwd: string;
}): Promise<{ id: string; pluginCount: number }> {
  const source = parseMarketplaceSource(opts.input, opts.cwd);
  const known = await loadKnownMarketplaces(opts.pluginsDir);
  const tmp = tempDir(opts.pluginsDir, "add");
  try {
    await materializeSource(source, tmp, { cwd: opts.cwd });
    const json = await readMarketplaceJson(tmp);
    const id = json.name;
    const dest = join(opts.pluginsDir, "marketplaces", id);
    await rmTree(dest);
    await mkdir(dirname(dest), { recursive: true });
    await cp(tmp, dest, { recursive: true });
    await upsertKnown(known, {
      id,
      source: normalizeKnownSource(source, opts.cwd),
      name: json.name,
      description: json.description,
      addedAt: new Date().toISOString(),
      pluginCount: json.plugins.length,
      lastUpdated: new Date().toISOString(),
    });
    await saveKnownMarketplaces(opts.pluginsDir, known);
    return { id, pluginCount: json.plugins.length };
  } finally {
    await rmTree(tmp);
  }
}

/** 刷新市场：按登记的来源重新物化（本地目录源=重新快照） */
export async function refreshMarketplace(opts: {
  id: string;
  pluginsDir: string;
  cwd: string;
}): Promise<{ id: string; pluginCount: number }> {
  const known = await loadKnownMarketplaces(opts.pluginsDir);
  const entry = known.marketplaces.find((m) => m.id === opts.id);
  if (!entry) {
    throw new PluginError(
      `未知市场 "${opts.id}"。已登记: ${known.marketplaces.map((m) => m.id).join("、") || "（无）"}`,
    );
  }
  const tmp = tempDir(opts.pluginsDir, "refresh");
  try {
    await materializeSource(entry.source as MarketplaceSource, tmp, { cwd: opts.cwd });
    const json = await readMarketplaceJson(tmp);
    const dest = join(opts.pluginsDir, "marketplaces", opts.id);
    await rmTree(dest);
    await cp(tmp, dest, { recursive: true });
    await upsertKnown(known, {
      ...entry,
      pluginCount: json.plugins.length,
      lastUpdated: new Date().toISOString(),
    });
    await saveKnownMarketplaces(opts.pluginsDir, known);
    return { id: opts.id, pluginCount: json.plugins.length };
  } finally {
    await rmTree(tmp);
  }
}

/** 移除市场登记与物化目录（已安装插件保留在 cache，可继续使用） */
export async function removeMarketplace(opts: {
  id: string;
  pluginsDir: string;
}): Promise<void> {
  const known = await loadKnownMarketplaces(opts.pluginsDir);
  const before = known.marketplaces.length;
  known.marketplaces = known.marketplaces.filter((m) => m.id !== opts.id);
  if (known.marketplaces.length === before) {
    throw new PluginError(`未知市场 "${opts.id}"。已登记: ${known.marketplaces.map((m) => m.id).join("、") || "（无）"}`);
  }
  await saveKnownMarketplaces(opts.pluginsDir, known);
  await rmTree(join(opts.pluginsDir, "marketplaces", opts.id));
}

async function upsertKnown(
  file: KnownMarketplacesFile,
  entry: KnownMarketplace,
): Promise<void> {
  const idx = file.marketplaces.findIndex((m) => m.id === entry.id);
  if (idx >= 0) file.marketplaces[idx] = entry;
  else file.marketplaces.push(entry);
}

/** 市场内插件清单（UI/CLI 浏览市场用） */
export async function listMarketplacePlugins(opts: {
  id: string;
  pluginsDir: string;
}): Promise<{ marketplace: MarketplaceJson; entries: MarketplacePluginEntry[] }> {
  const known = await loadKnownMarketplaces(opts.pluginsDir);
  const entry = known.marketplaces.find((m) => m.id === opts.id);
  if (!entry) {
    throw new PluginError(
      `未知市场 "${opts.id}"。已登记: ${known.marketplaces.map((m) => m.id).join("、") || "（无）"}`,
    );
  }
  const materialized = join(opts.pluginsDir, "marketplaces", opts.id);
  const base = marketplaceBaseDir(entry, materialized);
  // file 来源的 marketplace.json 在物化目录里也有一份，直接读物化目录即可
  const json = await readMarketplaceJson(materialized);
  void base;
  return { marketplace: json, entries: json.plugins };
}

/**
 * 安装插件：市场条目 → 解析来源 → 快照到 cache/<市场>/<插件>/<版本> → 写 seed。
 * dependencies 递归安装（失败降级为 problems，不阻塞主插件）。
 */
export async function installPlugin(opts: {
  marketId: string;
  pluginName: string;
  pluginsDir: string;
  cwd: string;
  /** 依赖递归防环 */
  seen?: Set<string>;
}): Promise<InstallTarget> {
  const seen = opts.seen ?? new Set<string>();
  const key = `${opts.pluginName}@${opts.marketId}`;
  if (seen.has(key)) {
    throw new PluginError(`插件依赖成环: ${[...seen, key].join(" → ")}`);
  }
  seen.add(key);

  const known = await loadKnownMarketplaces(opts.pluginsDir);
  const market = known.marketplaces.find((m) => m.id === opts.marketId);
  if (!market) {
    throw new PluginError(
      `未知市场 "${opts.marketId}"。先 /plugin market add 添加；已登记: ${known.marketplaces.map((m) => m.id).join("、") || "（无）"}`,
    );
  }
  const materialized = join(opts.pluginsDir, "marketplaces", opts.marketId);
  const json = await readMarketplaceJson(materialized);
  const entry = json.plugins.find((p) => p.name === opts.pluginName);
  if (!entry) {
    throw new PluginError(
      `市场 "${opts.marketId}" 中没有插件 "${opts.pluginName}"。可用: ${json.plugins.map((p) => p.name).join("、") || "（空）"}`,
    );
  }
  // 解析来源 → 本地目录（远端来源先克隆到临时目录，用完即清）
  const resolved = await resolvePluginSourceDir({
    entry,
    baseDir: marketplaceBaseDir(market, materialized),
    pluginRoot: json.pluginRoot,
    cwd: opts.cwd,
    pluginsDir: opts.pluginsDir,
  });
  try {
    const found = await findPluginManifest(resolved.dir);
    if (!found) {
      throw new PluginError(
        `来源目录 ${resolved.dir} 不是有效插件：缺少 .zcode-plugin/plugin.json（或 .claude-plugin/plugin.json）`,
      );
    }
    if (found.manifest.name !== opts.pluginName) {
      throw new PluginError(
        `清单名 "${found.manifest.name}" 与市场条目名 "${opts.pluginName}" 不一致。` +
          "请修正 marketplace.json 的条目名或插件的 plugin.json。",
      );
    }
    const version = entry.version ?? found.manifest.version;
    const dest = join(opts.pluginsDir, "cache", opts.marketId, opts.pluginName, version);
    await rmTree(dest);
    await copyTree(resolved.dir, dest);
    await pruneOldVersions(opts.pluginsDir, opts.marketId, opts.pluginName, version);

    const problems: string[] = [];
    const seed: PluginSeed = {
      version: 1,
      marketplace: opts.marketId,
      plugin: opts.pluginName,
      pluginVersion: version,
      source: describeSource(entry.source),
      hash: createHash("sha256").update(JSON.stringify(entry.source)).digest("hex"),
    };
    await writeSeed(dest, seed);

    for (const dep of found.manifest.dependencies ?? []) {
      const at = dep.lastIndexOf("@");
      const depName = at > 0 ? dep.slice(0, at) : dep;
      const depMarket = at > 0 ? dep.slice(at + 1) : opts.marketId;
      if (!depName || !depMarket) {
        problems.push(`依赖声明 "${dep}" 不合法（应为 name@market 或裸 name），已跳过`);
        continue;
      }
      try {
        await installPlugin({
          marketId: depMarket,
          pluginName: depName,
          pluginsDir: opts.pluginsDir,
          cwd: opts.cwd,
          seen,
        });
      } catch (err) {
        problems.push(`依赖 ${dep} 安装失败: ${errorMessage(err)}（主插件已安装，功能可能受限）`);
      }
    }
    return { root: dest, version, manifest: found.manifest, problems };
  } finally {
    await resolved.cleanup();
  }
}

/** 卸载插件：删除 cache 下该插件全部版本（配置里的启停标记一并清理由调用方负责） */
export async function uninstallPlugin(opts: {
  marketId: string;
  pluginName: string;
  pluginsDir: string;
}): Promise<void> {
  const dir = join(opts.pluginsDir, "cache", opts.marketId, opts.pluginName);
  await rmTree(dir);
}

/** 解析市场条目 source → 本地目录；远端来源克隆到临时目录，返回 cleanup 供用后清理 */
async function resolvePluginSourceDir(opts: {
  entry: MarketplacePluginEntry;
  baseDir: string;
  pluginRoot?: string;
  cwd: string;
  pluginsDir: string;
}): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const { entry, baseDir, pluginRoot, cwd } = opts;
  const noCleanup = async (): Promise<void> => {};
  const source = entry.source;
  if (typeof source === "string") {
    if (/^([a-zA-Z]:[\\/]|\/)/.test(source)) return { dir: source, cleanup: noCleanup };
    return { dir: join(baseDir, pluginRoot ?? "", source), cleanup: noCleanup };
  }
  switch (source.source) {
    case "directory":
    case "file": {
      const p = source.path ?? "";
      const dir = /^([a-zA-Z]:[\\/]|\/)/.test(p) ? p : join(cwd, p);
      return { dir, cleanup: noCleanup };
    }
    case "github":
    case "git": {
      // 仓库子路径：浅克隆到临时目录后取 path 子目录（cleanup 由调用方在拷贝后触发）
      const tmp = tempDir(opts.pluginsDir, "plugin-src");
      try {
        await materializeSource(source, tmp, { cwd });
      } catch (err) {
        await rmTree(tmp);
        throw new PluginError(
          `克隆插件仓库失败（${describeSource(source)}）：${errorMessage(err)}`,
        );
      }
      const dir = source.path ? join(tmp, source.path) : tmp;
      return { dir, cleanup: () => rmTree(tmp) };
    }
    case "url": {
      if (!source.url) throw new PluginError("url 来源缺少 url");
      if (source.type !== "zip" && !source.url.toLowerCase().endsWith(".zip")) {
        // url 直指插件目录本身无法表达（目录不可下载）；只支持 zip 分发
        throw new PluginError(
          "url 插件来源仅支持 zip 分发（type:\"zip\" 或 url 以 .zip 结尾）。" +
            "目录类插件请用 github/git 或 directory/file 来源。",
        );
      }
      // 下载 → sha256 校验 → 解压到临时目录，取 path 子目录（zip 内多一层目录时）
      const tmp = tempDir(opts.pluginsDir, "plugin-zip");
      const zipFile = `${tmp}.zip`;
      await mkdir(dirname(tmp), { recursive: true });
      try {
        await downloadFile(source.url, source.headers, zipFile, source.sha256);
        await extractZip(zipFile, tmp);
      } catch (err) {
        await rmTree(tmp);
        await rm(zipFile, { force: true, maxRetries: 3, retryDelay: 150 }).catch(() => {});
        throw err instanceof PluginError ? err : new PluginError(errorMessage(err));
      } finally {
        await rm(zipFile, { force: true, maxRetries: 3, retryDelay: 150 }).catch(() => {});
      }
      const dir = source.path ? join(tmp, source.path) : tmp;
      return { dir, cleanup: () => rmTree(tmp) };
    }
    case "npm":
      throw new PluginError(
        "暂不支持 npm 来源。可先 npm pack 到本地，用 directory/file 来源分发。",
      );
  }
}

async function pruneOldVersions(
  pluginsDir: string,
  marketId: string,
  pluginName: string,
  keepVersion: string,
): Promise<void> {
  const pluginDir = join(pluginsDir, "cache", marketId, pluginName);
  let entries;
  try {
    entries = await readdir(pluginDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === keepVersion) continue;
    await rmTree(join(pluginDir, e.name));
  }
}

/** 读取 marketId 下已安装的某插件最新版本根目录；未安装返回 null */
export async function installedPluginRoot(
  pluginsDir: string,
  marketId: string,
  pluginName: string,
): Promise<string | null> {
  const pluginDir = join(pluginsDir, "cache", marketId, pluginName);
  let entries;
  try {
    entries = await readdir(pluginDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const versions = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(compareVersions);
  const latest = versions[versions.length - 1];
  return latest ? join(pluginDir, latest) : null;
}

/** seed 文件读取（发现层校验用） */
export async function readSeed(pluginRoot: string): Promise<PluginSeed | null> {
  try {
    const raw = await readFile(join(pluginRoot, ".wcode-plugin-seed.json"), "utf8");
    const json = JSON.parse(raw) as Partial<PluginSeed>;
    if (json.marketplace && json.plugin) {
      return {
        version: 1,
        marketplace: json.marketplace,
        plugin: json.plugin,
        pluginVersion: json.pluginVersion ?? "0.0.0",
        source: json.source ?? "",
        hash: json.hash ?? "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** seed 文件写入（市场安装与内置插件播种共用） */
export async function writeSeed(pluginRoot: string, seed: PluginSeed): Promise<void> {
  await writeFile(join(pluginRoot, ".wcode-plugin-seed.json"), JSON.stringify(seed, null, 2), "utf8");
}
