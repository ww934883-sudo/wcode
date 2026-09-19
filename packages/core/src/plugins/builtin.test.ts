import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedBuiltinPlugins, BUILTIN_MARKET_ID } from "./builtin";
import { assembleExtensions } from "./discovery";
import { configSchema } from "../config/schema";

let root: string;
let cleanupRoot: () => Promise<void>;

/** 内置插件 fixture：manifest + 带变量引用的技能 */
async function writeBuiltinPlugin(
  builtinDir: string,
  name: string,
  version: string,
): Promise<void> {
  const dir = join(builtinDir, name);
  await mkdir(join(dir, ".zcode-plugin"), { recursive: true });
  await mkdir(join(dir, "skills", "demo"), { recursive: true });
  await writeFile(
    join(dir, ".zcode-plugin", "plugin.json"),
    JSON.stringify({ name, version, description: "内置测试插件" }),
    "utf8",
  );
  await writeFile(
    join(dir, "skills", "demo", "SKILL.md"),
    `---\ndescription: 内置技能\n---\n脚本路径: \${WCODE_PLUGIN_ROOT}/scripts/run.js（项目: \${WCODE_PROJECT_DIR}）`,
    "utf8",
  );
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "wcode-plugin-builtin-"));
  cleanupRoot = () => rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});
afterAll(async () => {
  await cleanupRoot();
});

function makeConfig(blocked?: string[]) {
  return configSchema.parse(blocked ? { plugins: { blockedBuiltins: blocked } } : {});
}

describe("seedBuiltinPlugins", () => {
  it("播种到 cache/wcode-builtin/<名>/<版本>，seed 文件齐全，正文变量已替换", async () => {
    const builtinDir = join(root, "builtin-1");
    const homeDir = join(root, "home-1");
    await writeBuiltinPlugin(builtinDir, "demo-plugin", "1.0.0");
    const cwd = join(root, "proj-1");
    await mkdir(cwd, { recursive: true });

    const res = await seedBuiltinPlugins({
      pluginsDir: join(homeDir, ".wcode", "plugins"),
      builtinDir,
    });
    expect(res.seeded).toEqual(["demo-plugin"]);
    const seed = JSON.parse(
      await readFile(
        join(homeDir, ".wcode", "plugins", "cache", BUILTIN_MARKET_ID, "demo-plugin", "1.0.0", ".wcode-plugin-seed.json"),
        "utf8",
      ),
    ) as { marketplace: string; plugin: string; pluginVersion: string };
    expect(seed.marketplace).toBe("wcode-builtin");
    expect(seed.plugin).toBe("demo-plugin");

    // 组装后技能名命名空间化 + 正文变量替换为真实路径
    const bundle = await assembleExtensions({
      cwd,
      homeDir: join(homeDir, ".wcode"),
      config: makeConfig(),
    });
    const skill = bundle.skills.find((s) => s.name === "demo-plugin:demo");
    expect(skill?.body).toContain(join(homeDir, ".wcode", "plugins", "cache", BUILTIN_MARKET_ID, "demo-plugin", "1.0.0"));
    expect(skill?.body).toContain(cwd);
    expect(skill?.body).not.toContain("${WCODE_PLUGIN_ROOT}");
  });

  it("重复启动幂等（skipped），版本升级重播种并清理旧版本目录", async () => {
    const builtinDir = join(root, "builtin-2");
    const pluginsDir = join(root, "home-2", ".wcode", "plugins");
    await writeBuiltinPlugin(builtinDir, "up-plugin", "1.0.0");
    await seedBuiltinPlugins({ pluginsDir, builtinDir });
    const res2 = await seedBuiltinPlugins({ pluginsDir, builtinDir });
    expect(res2.skipped).toEqual(["up-plugin"]);
    expect(res2.seeded).toEqual([]);

    await writeBuiltinPlugin(builtinDir, "up-plugin", "2.0.0");
    const res3 = await seedBuiltinPlugins({ pluginsDir, builtinDir });
    expect(res3.seeded).toEqual(["up-plugin"]);
    await expect(
      readFile(join(pluginsDir, "cache", BUILTIN_MARKET_ID, "up-plugin", "1.0.0", ".wcode-plugin-seed.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("卸载屏蔽名单内的内置插件不装回", async () => {
    const builtinDir = join(root, "builtin-3");
    const pluginsDir = join(root, "home-3", ".wcode", "plugins");
    await writeBuiltinPlugin(builtinDir, "blocked-plugin", "1.0.0");
    const res = await seedBuiltinPlugins({ pluginsDir, builtinDir, blockedBuiltins: ["blocked-plugin"] });
    expect(res.blocked).toEqual(["blocked-plugin"]);
    expect(res.seeded).toEqual([]);
  });

  it("builtinDir 不存在视为无内置插件（不报问题）", async () => {
    const res = await seedBuiltinPlugins({
      pluginsDir: join(root, "home-4", ".wcode", "plugins"),
      builtinDir: join(root, "no-such-builtin"),
    });
    expect(res).toEqual({ seeded: [], skipped: [], blocked: [], problems: [] });
  });
});

describe("仓库内置插件包（真实内容 smoke）", () => {
  const repoBuiltinDir = fileURLToPath(new URL("../../plugins-builtin", import.meta.url));

  it("browser-use / computer-use 清单合法、技能可发现、脚本就位", async () => {
    const homeDir = join(root, "home-real");
    const cwd = join(root, "proj-real");
    await mkdir(cwd, { recursive: true });
    const pluginsDir = join(homeDir, ".wcode", "plugins");
    const res = await seedBuiltinPlugins({ pluginsDir, builtinDir: repoBuiltinDir });
    expect(res.seeded).toEqual(["browser-use", "computer-use"]);
    expect(res.problems).toEqual([]);

    const bundle = await assembleExtensions({
      cwd,
      homeDir: join(homeDir, ".wcode"),
      config: makeConfig(),
    });
    const names = bundle.plugins.map((p) => `${p.name}@${p.marketplace}`).sort();
    expect(names).toEqual(["browser-use@wcode-builtin", "computer-use@wcode-builtin"]);

    const browserSkill = bundle.skills.find((s) => s.name === "browser-use:control-browser");
    expect(browserSkill?.description).toContain("浏览器");
    // 正文里的脚本引用在装配时已替换为 cache 内真实路径
    expect(browserSkill?.body).toContain(`node "${join(pluginsDir, "cache", BUILTIN_MARKET_ID, "browser-use", "0.1.2")}/scripts/cdp.js"`);
    const desktopSkill = bundle.skills.find((s) => s.name === "computer-use:control-desktop");
    expect(desktopSkill?.body).toContain("screenshot.ps1");
  });
});
