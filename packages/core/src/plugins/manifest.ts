import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage } from "../errors";
import { mcpServerSpecSchema } from "../config/schema";

/** 插件名约束（对齐 zcode）：小写字母/数字开头，可含点/连字符/下划线 */
export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** 清单查找顺序：.zcode-plugin 优先，.claude-plugin 兼容（Claude Code 插件可直接复用） */
export const MANIFEST_LOCATIONS = [
  { dir: ".zcode-plugin", file: "plugin.json", format: "zcode" as const },
  { dir: ".claude-plugin", file: "plugin.json", format: "claude" as const },
];

const authorSchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    url: z.string().optional(),
    email: z.string().optional(),
  }),
]);

const authorOutSchema = z.object({
  name: z.string().optional(),
  url: z.string().optional(),
  email: z.string().optional(),
});

/** 组件路径字段：目录字符串或路径数组（相对插件根） */
const componentPaths = z.union([z.string(), z.array(z.string())]);

export const pluginJsonSchema = z.object({
  name: z
    .string()
    .regex(PLUGIN_NAME_RE, `需匹配 ${PLUGIN_NAME_RE.source}`),
  version: z.string().default("0.0.0"),
  description: z.string().optional(),
  author: authorSchema.optional(),
  homepage: z.string().optional(),
  repository: z.union([z.string(), z.object({ url: z.string() })]).optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  commands: componentPaths.optional(),
  skills: componentPaths.optional(),
  agents: componentPaths.optional(),
  /** hooks/hooks.json 路径（相对插件根） */
  hooks: z.string().optional(),
  /** .mcp.json 路径（相对插件根）、路径数组或内联服务器声明 */
  mcpServers: z.union([componentPaths, z.record(z.string(), mcpServerSpecSchema)]).optional(),
  /** 依赖的其他插件：`name@market` 或同市场裸 `name` */
  dependencies: z.array(z.string()).optional(),
  /** 用户配置项声明（v1 仅登记，值引用 ${user_config.键} 暂不解析） */
  userConfig: z
    .record(
      z.string(),
      z.object({
        type: z.enum(["string", "number", "boolean", "directory", "file"]),
        title: z.string().optional(),
        description: z.string().optional(),
        default: z.unknown().optional(),
        required: z.boolean().optional(),
        sensitive: z.boolean().optional(),
      }),
    )
    .optional(),
});

export type PluginAuthor = z.infer<typeof authorOutSchema>;

export type PluginManifest = {
  name: string;
  version: string;
  description?: string;
  author?: string | { name?: string; url?: string; email?: string };
  homepage?: string;
  repository?: string | { url: string };
  license?: string;
  keywords?: string[];
  commands?: string | string[];
  skills?: string | string[];
  agents?: string | string[];
  hooks?: string;
  mcpServers?: string | string[] | Record<string, unknown>;
  dependencies?: string[];
  userConfig?: Record<
    string,
    {
      type: "string" | "number" | "boolean" | "directory" | "file";
      title?: string;
      description?: string;
      default?: unknown;
      required?: boolean;
      sensitive?: boolean;
    }
  >;
};

export interface PluginManifestInfo {
  /** 插件根目录（含 .zcode-plugin/ 的那一层） */
  root: string;
  /** 清单文件的绝对路径 */
  path: string;
  manifest: PluginManifest;
  /** 清单格式来源：zcode（.zcode-plugin）或 claude（.claude-plugin 兼容层） */
  format: "zcode" | "claude";
}

/**
 * 在插件根目录查找并解析清单。返回 null = 没有清单（目录不存在是常态）；
 * 抛出 ConfigError 语义的错误文本由调用方转 problems（清单存在但非法要报清楚）。
 */
export async function findPluginManifest(
  root: string,
): Promise<PluginManifestInfo | null> {
  let raw: string | null = null;
  let hit: (typeof MANIFEST_LOCATIONS)[number] | null = null;
  let lastError = "";
  for (const loc of MANIFEST_LOCATIONS) {
    const path = join(root, loc.dir, loc.file);
    try {
      raw = await readFile(path, "utf8");
      hit = loc;
      break;
    } catch (err) {
      // ENOENT = 该位置没有清单，继续找下一位置；其他读取错误记录后同样继续
      lastError = errorMessage(err);
    }
  }
  if (!raw || !hit) {
    if (lastError && !lastError.includes("ENOENT")) {
      throw new Error(`读取插件清单失败: ${lastError}`);
    }
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`插件清单 ${hit.dir}/${hit.file} 不是合法 JSON: ${errorMessage(err)}`);
  }
  const parsed = pluginJsonSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? issue.path.join(".") || "(根)" : "?";
    throw new Error(
      `插件清单 ${hit.dir}/${hit.file} 不合法：字段 ${where} ${issue?.message ?? "校验失败"}。` +
        `最小清单只需 {"name": "..."}（小写字母/数字开头，可含 . _ -）`,
    );
  }
  return { root, path: join(root, hit.dir, hit.file), manifest: parsed.data, format: hit.format };
}

/** 归一 author 字段：字符串与对象统一为对象形式（展示用） */
export function normalizeAuthor(
  author: PluginManifest["author"],
): PluginAuthor | undefined {
  if (!author) return undefined;
  if (typeof author === "string") return { name: author };
  return author;
}

/** 组件路径字段归一为数组（清单里写成字符串时是单目录） */
export function componentPathsToList(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
