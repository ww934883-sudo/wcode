import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { errorMessage } from "../errors";

/**
 * 插件市场（对齐 zcode）：
 *   - 市场仓库根放 marketplace.json，插件放仓库内（pluginRoot + 相对 source）
 *   - 本机登记在 ~/.wcode/plugins/known_marketplaces.json（与 zcode 同名同构）
 *   - 市场内容物化在 ~/.wcode/plugins/marketplaces/<id>/
 */

/** 插件来源声明：相对路径字符串或对象形式（url/npm 仅登记，安装时报暂不支持） */
export const marketplaceSourceSchema = z.union([
  z.string().min(1),
  z.object({
    source: z.enum(["github", "git", "directory", "file", "url", "npm"]),
    /** github: "owner/repo" 或含子路径；git: 仓库 url */
    repo: z.string().optional(),
    url: z.string().optional(),
    /** git/url 的凭据头 */
    headers: z.record(z.string(), z.string()).optional(),
    /** directory/file: 本地路径；github/git/url(zip): 仓库/压缩包内子路径 */
    path: z.string().optional(),
    ref: z.string().optional(),
    package: z.string().optional(),
    type: z.string().optional(),
    /** url(zip) 来源的完整性校验（zcode 官方市场条目带 sha256） */
    sha256: z.string().optional(),
  }),
]);

export type MarketplaceSource =
  | string
  | {
      source: "github" | "git" | "directory" | "file" | "url" | "npm";
      repo?: string;
      url?: string;
      headers?: Record<string, string>;
      path?: string;
      ref?: string;
      package?: string;
      type?: string;
      sha256?: string;
    };

export const marketplaceJsonSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /** 插件相对本文件的公共父目录（可选） */
  pluginRoot: z.string().optional(),
  plugins: z
    .array(
      z.object({
        name: z.string().min(1),
        source: marketplaceSourceSchema,
        description: z.string().optional(),
        version: z.string().optional(),
        author: z.unknown().optional(),
        category: z.string().optional(),
        tags: z.array(z.string()).optional(),
        dependencies: z.array(z.string()).optional(),
        strict: z.boolean().optional(),
      }),
    )
    .min(1),
  allowCrossMarketplaceDependenciesOn: z.array(z.string()).optional(),
});

export type MarketplaceJson = z.infer<typeof marketplaceJsonSchema>;
export type MarketplacePluginEntry = MarketplaceJson["plugins"][number];

export interface KnownMarketplace {
  id: string;
  source: Exclude<MarketplaceSource, string> | string;
  name?: string;
  description?: string;
  addedAt: string;
  pluginCount?: number;
  lastUpdated?: string;
}

export interface KnownMarketplacesFile {
  version: 1;
  marketplaces: KnownMarketplace[];
}

/** 读取 known_marketplaces.json；文件不存在视为空登记（常态） */
export async function loadKnownMarketplaces(
  pluginsDir: string,
): Promise<KnownMarketplacesFile> {
  try {
    const raw = await readFile(join(pluginsDir, "known_marketplaces.json"), "utf8");
    const json = JSON.parse(raw) as Partial<KnownMarketplacesFile>;
    return {
      version: 1,
      marketplaces: Array.isArray(json.marketplaces) ? json.marketplaces : [],
    };
  } catch {
    return { version: 1, marketplaces: [] };
  }
}

export async function saveKnownMarketplaces(
  pluginsDir: string,
  file: KnownMarketplacesFile,
): Promise<void> {
  await mkdir(pluginsDir, { recursive: true });
  await writeFile(
    join(pluginsDir, "known_marketplaces.json"),
    JSON.stringify(file, null, 2),
    "utf8",
  );
}

/** 市场来源登记格式：目录/文件用绝对路径字符串，远端用对象（对齐 zcode known 文件） */
export function normalizeKnownSource(
  source: MarketplaceSource,
  cwd: string,
): KnownMarketplace["source"] {
  if (typeof source === "string") return source;
  if (source.source === "directory" || source.source === "file") {
    const p = source.path ?? "";
    return { source: source.source, path: isAbsolute(p) ? p : join(cwd, p) };
  }
  return source;
}

/**
 * 把用户输入解析为市场来源（/plugin market add 的输入）：
 *   本地目录/文件 → directory/file；owner/repo → github；
 *   *.git 或 git+ 前缀 → git；http(s)://…json → url；其余 http(s) → git
 */
export function parseMarketplaceSource(input: string, cwd: string): MarketplaceSource {
  const t = input.trim();
  if (!t) throw new Error("市场来源为空。用法：本地目录/文件路径、owner/repo 或仓库 git url");
  if (t.startsWith("git+") || t.endsWith(".git")) {
    return { source: "git", url: t.startsWith("git+") ? t.slice(4) : t };
  }
  if (/^https?:\/\//i.test(t)) {
    return t.split("?")[0]?.endsWith(".json")
      ? { source: "url", url: t }
      : { source: "git", url: t };
  }
  if (/^[a-zA-Z]:[\\/]/.test(t) || t.startsWith("/") || t.startsWith("~/") || t.startsWith(".\\")) {
    return { source: "directory", path: t };
  }
  // 相对路径（含 ./ 与盘符外的情况）：本地存在才算，否则按 github repo 解析
  if (t.startsWith("./") || t.startsWith("../")) {
    return { source: "directory", path: join(cwd, t) };
  }
  if (/^[\w.-]+\/[\w.-]+(\/[\w.-]+)*$/.test(t)) {
    return { source: "github", repo: t };
  }
  return { source: "directory", path: join(cwd, t) };
}

/** 市场来源的展示文案（UI/CLI 列表用） */
export function describeSource(source: KnownMarketplace["source"]): string {
  if (typeof source === "string") return source;
  switch (source.source) {
    case "github":
      return `github:${source.repo ?? "?"}`;
    case "git":
      return source.url ?? "git";
    case "directory":
      return source.path ?? "directory";
    case "file":
      return source.path ?? "file";
    case "url":
      return source.url ?? "url";
    case "npm":
      return `npm:${source.package ?? "?"}`;
  }
}

/** 解析 marketplace.json；解析失败抛带 label 的可行动错误 */
export function parseMarketplaceJson(json: unknown, label: string): MarketplaceJson {
  const parsed = marketplaceJsonSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? issue.path.join(".") || "(根)" : "?";
    throw new Error(
      `${label} 不合法：字段 ${where} ${issue?.message ?? "校验失败"}。` +
        `最小结构: {"name": "...", "plugins": [{"name": "...", "source": "./插件目录"}]}`,
    );
  }
  return parsed.data;
}

export async function readMarketplaceJson(dir: string): Promise<MarketplaceJson> {
  const path = join(dir, "marketplace.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(
      `市场目录 ${dir} 下没有 marketplace.json（读取失败: ${errorMessage(err)}）。` +
        "市场仓库根目录必须包含 marketplace.json。",
    );
  }
  try {
    return parseMarketplaceJson(JSON.parse(raw), "marketplace.json");
  } catch (err) {
    throw new Error(`${errorMessage(err)}（文件: ${path}）`);
  }
}

export function defaultPluginsDir(homeDir?: string): string {
  const base = homeDir ?? join(homedir(), ".wcode");
  return join(base, "plugins");
}
