import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addMarketplace,
  installPlugin,
  uninstallPlugin,
  removeMarketplace,
  listMarketplacePlugins,
  compareVersions,
} from "./install";
import { loadKnownMarketplaces } from "./marketplace";
import { assembleExtensions } from "./discovery";
import { configSchema } from "../config/schema";

let root: string;
let cleanupRoot: () => Promise<void>;

/** 市场 fixture：marketplace.json + 插件 hello（含技能/命令） */
async function writeMarketplace(marketDir: string): Promise<void> {
  const pluginDir = join(marketDir, "plugins", "hello");
  await mkdir(join(pluginDir, ".zcode-plugin"), { recursive: true });
  await mkdir(join(pluginDir, "skills", "demo"), { recursive: true });
  await mkdir(join(pluginDir, "commands"), { recursive: true });
  await writeFile(
    join(marketDir, "marketplace.json"),
    JSON.stringify({
      name: "local-test",
      description: "测试市场",
      plugins: [{ name: "hello", source: "./plugins/hello", description: "问候插件", version: "1.0.0" }],
    }),
    "utf8",
  );
  await writeFile(
    join(pluginDir, ".zcode-plugin", "plugin.json"),
    JSON.stringify({ name: "hello", version: "1.0.0", description: "问候插件" }),
    "utf8",
  );
  await writeFile(
    join(pluginDir, "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: 打招呼技能\n---\n说 hello",
    "utf8",
  );
  await writeFile(
    join(pluginDir, "commands", "greet.md"),
    "---\ndescription: 打招呼命令\nargument-hint: <名字>\n---\n向 $1 说 hello",
    "utf8",
  );
}

/** 本地 git 仓库 fixture（git 来源安装路径，克隆本地路径不需要网络） */
async function writeGitMarketplace(repoDir: string): Promise<string> {
  await writeMarketplace(repoDir);
  const git = (args: string[]): void => {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: repoDir,
      stdio: "ignore",
    });
  };
  git(["init", "--quiet"]);
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "init"]);
  return repoDir;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "wcode-plugin-install-"));
  cleanupRoot = () => rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});
afterAll(async () => {
  await cleanupRoot();
});

describe("marketplace 登记 + 安装（directory 来源）", () => {
  it("add → list → install → 发现组件 → uninstall → remove 全链路", async () => {
    const marketSrc = join(root, "market-src");
    const pluginsDir = join(root, "plugins-home", "plugins");
    const cwd = join(root, "proj");
    await mkdir(cwd, { recursive: true });
    await writeMarketplace(marketSrc);

    const added = await addMarketplace({ input: marketSrc, pluginsDir, cwd });
    expect(added.id).toBe("local-test");
    expect(added.pluginCount).toBe(1);

    const known = await loadKnownMarketplaces(pluginsDir);
    expect(known.marketplaces[0]?.id).toBe("local-test");

    const { entries } = await listMarketplacePlugins({ id: "local-test", pluginsDir });
    expect(entries[0]?.name).toBe("hello");

    const target = await installPlugin({ marketId: "local-test", pluginName: "hello", pluginsDir, cwd });
    expect(target.version).toBe("1.0.0");
    const seed = JSON.parse(
      await readFile(join(target.root, ".wcode-plugin-seed.json"), "utf8"),
    ) as { marketplace: string; plugin: string };
    expect(seed.marketplace).toBe("local-test");
    expect(seed.plugin).toBe("hello");

    // assembleExtensions：命名空间化的技能与命令进入 bundle
    const config = configSchema.parse({});
    const bundle = await assembleExtensions({ cwd, homeDir: join(root, "plugins-home"), config });
    const skill = bundle.skills.find((s) => s.name === "hello:demo");
    expect(skill?.description).toBe("打招呼技能");
    const cmd = bundle.commands.find((c) => c.qualifiedName === "hello:greet");
    expect(cmd?.body).toContain("$1");

    await uninstallPlugin({ marketId: "local-test", pluginName: "hello", pluginsDir });
    const bundle2 = await assembleExtensions({ cwd, homeDir: join(root, "plugins-home"), config });
    expect(bundle2.skills.find((s) => s.name === "hello:demo")).toBeUndefined();
    expect(bundle2.plugins.find((p) => p.name === "hello")).toBeUndefined();

    await removeMarketplace({ id: "local-test", pluginsDir });
    expect((await loadKnownMarketplaces(pluginsDir)).marketplaces).toHaveLength(0);
  });

  it("config.plugins.enabled=false 停用后组件不进 bundle", async () => {
    const marketSrc = join(root, "market-src-2");
    const homeDir = join(root, "plugins-home-2");
    const pluginsDir = join(homeDir, "plugins");
    const cwd = join(root, "proj-2");
    await mkdir(cwd, { recursive: true });
    await writeMarketplace(marketSrc);
    await addMarketplace({ input: marketSrc, pluginsDir, cwd });
    await installPlugin({ marketId: "local-test", pluginName: "hello", pluginsDir, cwd });

    const config = configSchema.parse({ plugins: { enabled: { "hello@local-test": false } } });
    const bundle = await assembleExtensions({ cwd, homeDir, config });
    expect(bundle.plugins[0]?.enabled).toBe(false);
    expect(bundle.skills.find((s) => s.name === "hello:demo")).toBeUndefined();
    expect(bundle.commands.find((c) => c.qualifiedName === "hello:greet")).toBeUndefined();
  });
});

describe("git 来源安装（本地仓库克隆）", () => {
  it("marketplace 条目用 git 对象来源也能安装", async () => {
    const repo = await writeGitMarketplace(join(root, "market-git-repo"));
    // 克隆出的是 .git 工作副本：把市场条目改成指向该仓库
    const marketSrc = join(root, "market-src-git");
    const pluginsDir = join(root, "plugins-home-git", "plugins");
    const cwd = join(root, "proj-git");
    await mkdir(cwd, { recursive: true });
    await mkdir(marketSrc, { recursive: true });
    await writeFile(
      join(marketSrc, "marketplace.json"),
      JSON.stringify({
        name: "git-test",
        plugins: [{ name: "hello", source: { source: "git", url: repo, path: "plugins/hello" }, version: "1.0.0" }],
      }),
      "utf8",
    );
    await addMarketplace({ input: marketSrc, pluginsDir, cwd });
    const target = await installPlugin({ marketId: "git-test", pluginName: "hello", pluginsDir, cwd });
    expect(target.manifest.name).toBe("hello");
    expect(target.problems).toEqual([]);
  });

  it("git clone 失败时错误取 stderr 末尾的真实原因并附可行动提示", async () => {
    const marketSrc = join(root, "market-src-err");
    const pluginsDir = join(root, "plugins-home-err", "plugins");
    const cwd = join(root, "proj-err");
    await mkdir(cwd, { recursive: true });
    await mkdir(marketSrc, { recursive: true });
    const missingRepo = join(root, "no-such-repo");
    await writeFile(
      join(marketSrc, "marketplace.json"),
      JSON.stringify({
        name: "err-test",
        plugins: [{ name: "x", source: { source: "git", url: missingRepo } }],
      }),
      "utf8",
    );
    await addMarketplace({ input: marketSrc, pluginsDir, cwd });
    const err = (await installPlugin({
      marketId: "err-test",
      pluginName: "x",
      pluginsDir,
      cwd,
    }).then(
      () => null,
      (e: unknown) => e,
    )) as Error | null;
    if (!err) throw new Error("installPlugin 应当失败");
    // "Cloning into ..." 只是进度行；可行动原因（含提示）必须在错误里
    expect(err.message).not.toContain("Cloning into");
    expect(err.message).toMatch(/fatal:|Could not read from remote repository/i);
    expect(err.message).toContain("请确认仓库");
  });
});

describe("url(zip) 来源安装（zcode 官方市场形态）", () => {
  it("下载 zip → sha256 校验 → 解压 → 安装成功；校验失败给教学错误", async () => {
    // 造 zip：本地插件目录 → Compress-Archive（win32）；失败则跳过（环境缺命令）
    const pluginDir = join(root, "zip-plugin-src");
    await mkdir(join(pluginDir, "skills", "demo"), { recursive: true });
    await mkdir(join(pluginDir, ".zcode-plugin"), { recursive: true });
    await writeFile(
      join(pluginDir, ".zcode-plugin", "plugin.json"),
      JSON.stringify({ name: "zip-hello", version: "2.0.0", description: "zip 插件" }),
      "utf8",
    );
    await writeFile(
      join(pluginDir, "skills", "demo", "SKILL.md"),
      "---\ndescription: zip 技能\n---\n内容",
      "utf8",
    );
    const zipPath = join(root, "zip-hello.zip");
    const compress = (): void => {
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Compress-Archive -Path "${join(pluginDir, "*")}" -DestinationPath "${zipPath}" -Force`,
        ],
        { stdio: "ignore" },
      );
    };
    try {
      compress();
    } catch {
      return; // 环境无 powershell：跳过 zip 用例（其余安装路径仍有覆盖）
    }
    const zipBuf = await readFile(zipPath);
    const sha256 = createHash("sha256").update(zipBuf).digest("hex");

    // 本地 http 服务模拟 CDN 分发（每次请求从磁盘读，便于后续篡改场景）
    const server = createServer((_req, res) => {
      void readFile(zipPath).then(
        (buf) => {
          res.writeHead(200, { "content-type": "application/zip" });
          res.end(buf);
        },
        () => {
          res.writeHead(500);
          res.end();
        },
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      server.close();
      throw new Error("http server 未监听");
    }
    const url = `http://127.0.0.1:${addr.port}/plugin.zip`;

    try {
      const marketSrc = join(root, "market-src-zip");
      const pluginsDir = join(root, "plugins-home-zip", "plugins");
      const cwd = join(root, "proj-zip");
      await mkdir(cwd, { recursive: true });
      await mkdir(marketSrc, { recursive: true });
      await writeFile(
        join(marketSrc, "marketplace.json"),
        JSON.stringify({
          name: "zip-test",
          plugins: [
            { name: "zip-hello", source: { source: "url", type: "zip", url, sha256 }, version: "2.0.0" },
          ],
        }),
        "utf8",
      );
      await addMarketplace({ input: marketSrc, pluginsDir, cwd });
      const target = await installPlugin({ marketId: "zip-test", pluginName: "zip-hello", pluginsDir, cwd });
      expect(target.version).toBe("2.0.0");
      const config = configSchema.parse({});
      const bundle = await assembleExtensions({ cwd, homeDir: join(root, "plugins-home-zip"), config });
      expect(bundle.skills.map((s) => s.name)).toContain("zip-hello:demo");

      // sha256 不符：换内容再装 → 教学错误
      await writeFile(join(pluginDir, "skills", "demo", "SKILL.md"), "---\ndescription: 篡改\n---\nx", "utf8");
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Compress-Archive -Path "${join(pluginDir, "*")}" -DestinationPath "${zipPath}" -Force`,
        ],
        { stdio: "ignore" },
      );
      const tampered = await installPlugin({ marketId: "zip-test", pluginName: "zip-hello", pluginsDir, cwd }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(tampered?.message).toContain("sha256 校验失败");
    } finally {
      server.close();
    }
  });
});

describe("compareVersions", () => {
  it("按数值段比较", () => {
    expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
});
