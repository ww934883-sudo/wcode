import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleExtensions } from "./discovery";
import { configSchema } from "../config/schema";

let root: string;
let cleanupRoot: () => Promise<void>;

/** 手工摆放 cache 布局的插件（绕过安装器，直接测发现与合并） */
async function writeInstalledPlugin(opts: {
  homeDir: string;
  market: string;
  plugin: string;
  version?: string;
  skills?: string;
  commands?: string;
  hooksJson?: string;
  mcpJson?: string;
  format?: "zcode" | "claude";
}): Promise<string> {
  const version = opts.version ?? "1.0.0";
  const pluginRoot = join(opts.homeDir, "plugins", "cache", opts.market, opts.plugin, version);
  const manifestDir = opts.format === "claude" ? ".claude-plugin" : ".zcode-plugin";
  await mkdir(join(pluginRoot, manifestDir), { recursive: true });
  await writeFile(
    join(pluginRoot, manifestDir, "plugin.json"),
    JSON.stringify({ name: opts.plugin, version, description: "测试插件" }),
    "utf8",
  );
  if (opts.skills !== undefined) {
    await mkdir(join(pluginRoot, "skills", "demo"), { recursive: true });
    await writeFile(join(pluginRoot, "skills", "demo", "SKILL.md"), opts.skills, "utf8");
  }
  if (opts.commands !== undefined) {
    await mkdir(join(pluginRoot, "commands"), { recursive: true });
    await writeFile(join(pluginRoot, "commands", "greet.md"), opts.commands, "utf8");
  }
  if (opts.hooksJson !== undefined) {
    await mkdir(join(pluginRoot, "hooks"), { recursive: true });
    await writeFile(join(pluginRoot, "hooks", "hooks.json"), opts.hooksJson, "utf8");
  }
  if (opts.mcpJson !== undefined) {
    await writeFile(join(pluginRoot, ".mcp.json"), opts.mcpJson, "utf8");
  }
  return pluginRoot;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "wcode-plugin-discovery-"));
  cleanupRoot = () => rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});
afterAll(async () => {
  await cleanupRoot();
});

function makeConfig(enabled?: Record<string, boolean>) {
  return configSchema.parse(enabled ? { plugins: { enabled } } : {});
}

describe("assembleExtensions", () => {
  it("插件技能/命令/hooks/MCP 命名空间化合并；hooks 与配置合并拼接", async () => {
    const homeDir = join(root, "home-1");
    await writeInstalledPlugin({
      homeDir,
      market: "m1",
      plugin: "docs",
      skills: "---\ndescription: 搜索文档\n---\n搜索 $ARGUMENTS",
      commands: "---\ndescription: 生成索引\n---\n索引 $ARGUMENTS",
      hooksJson: JSON.stringify({
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo submitted" }] }],
        PreToolUse: [{ matcher: "bash", hooks: [{ command: "echo tool" }] }],
      }),
      mcpJson: JSON.stringify({
        mcpServers: {
          search: { command: "node", args: ["${ZCODE_PLUGIN_ROOT}", "server.js"] },
        },
      }),
    });
    const cwd = join(root, "proj-1");
    await mkdir(cwd, { recursive: true });
    const bundle = await assembleExtensions({ cwd, homeDir, config: makeConfig() });

    expect(bundle.skills.map((s) => s.name)).toContain("docs:demo");
    expect(bundle.commands.map((c) => c.qualifiedName)).toContain("docs:greet");
    expect(bundle.hooks.userPromptSubmit).toHaveLength(1);
    expect(bundle.hooks.preToolUse[0]?.matcher).toBe("bash");
    // MCP：键 = plugin:<插件>:<服务>；${ZCODE_PLUGIN_ROOT} 已替换为插件根
    const mcp = bundle.mcpServers["plugin:docs:search"];
    expect(mcp?.command).toBe("node");
    expect(mcp?.args?.[0]).toBe(join(homeDir, "plugins", "cache", "m1", "docs", "1.0.0"));
  });

  it("两个插件提供同名命名空间技能时先发现的保留并报 problem", async () => {
    const homeDir = join(root, "home-2");
    const cwd = join(root, "proj-2");
    await writeInstalledPlugin({
      homeDir,
      market: "m2",
      plugin: "docs",
      skills: "---\ndescription: 先到的插件版\n---\n内容",
    });
    await writeInstalledPlugin({
      homeDir,
      market: "m2b",
      plugin: "docs",
      skills: "---\ndescription: 后到的插件版\n---\n内容",
    });
    const bundle = await assembleExtensions({ cwd, homeDir, config: makeConfig() });
    const demos = bundle.skills.filter((s) => s.name === "docs:demo");
    expect(demos).toHaveLength(1);
    expect(demos[0]?.description).toBe("先到的插件版");
    expect(bundle.problems.join("\n")).toContain("重名");
  });

  it("用户级自定义命令与插件命令并存，裸名可唯一定位", async () => {
    const homeDir = join(root, "home-3");
    const cwd = join(root, "proj-3");
    await mkdir(join(homeDir, "commands"), { recursive: true });
    await writeFile(
      join(homeDir, "commands", "local.md"),
      "---\ndescription: 本地命令\n---\n本地",
      "utf8",
    );
    await writeInstalledPlugin({
      homeDir,
      market: "m3",
      plugin: "tools",
      commands: "---\ndescription: 插件命令\n---\n插件",
    });
    const bundle = await assembleExtensions({ cwd, homeDir, config: makeConfig() });
    const names = bundle.commands.map((c) => c.qualifiedName).sort();
    expect(names).toEqual(["local", "tools:greet"]);
    expect(bundle.commands.find((c) => c.name === "local")?.source).toBe("user");
  });

  it(".claude-plugin 兼容清单同样被发现", async () => {
    const homeDir = join(root, "home-4");
    await writeInstalledPlugin({
      homeDir,
      market: "m4",
      plugin: "legacy",
      format: "claude",
      skills: "---\ndescription: 旧格式技能\n---\n内容",
    });
    const cwd = join(root, "proj-4");
    await mkdir(cwd, { recursive: true });
    const bundle = await assembleExtensions({ cwd, homeDir, config: makeConfig() });
    expect(bundle.plugins[0]?.format).toBe("claude");
    expect(bundle.skills.map((s) => s.name)).toContain("legacy:demo");
  });

  it("多版本目录只取最新版本", async () => {
    const homeDir = join(root, "home-5");
    const cwd = join(root, "proj-5");
    await writeInstalledPlugin({ homeDir, market: "m5", plugin: "multi", version: "1.0.0", skills: "---\ndescription: v1\n---\n旧" });
    await writeInstalledPlugin({ homeDir, market: "m5", plugin: "multi", version: "2.0.0", skills: "---\ndescription: v2\n---\n新" });
    const bundle = await assembleExtensions({ cwd, homeDir, config: makeConfig() });
    const plugin = bundle.plugins.find((p) => p.name === "multi");
    expect(plugin?.version).toBe("2.0.0");
    expect(plugin?.skills[0]?.description).toBe("v2");
  });
});
