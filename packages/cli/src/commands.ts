import { homedir } from "node:os";
import { join } from "node:path";
import { errorMessage, isAbortedError } from "@wcode/core";
import type {
  AgentHost,
  AgentSession,
  CommandDefinition,
  DiscoveredPlugin,
  Logger,
  ModelProvider,
  ModelRequest,
  SessionDriver,
  SessionSummary,
  SkillDefinition,
  ToolRegistry,
  WcodeConfig,
} from "@wcode/core";
import {
  addMarketplace,
  BUILTIN_MARKET_ID,
  defaultPluginsDir,
  describeSource,
  discoverInstalledPlugins,
  expandCommandBody,
  findCommand,
  installPlugin,
  listMarketplacePlugins,
  loadKnownMarketplaces,
  patchUserSettings,
  pluginKey,
  refreshMarketplace,
  removeMarketplace,
  uninstallPlugin,
} from "@wcode/core";
import { messagesFromSessionLines } from "@wcode/core";
import { mapSlashCommand } from "./slash";

/** 命令输出通道（bin 装配时映射到 InkHost，core 接口不进 UI 层） */
export interface CommandSink {
  /** 灰色提示行 */
  note(text: string): void;
  /** markdown 输出（/help、/btw 回答、技能列表） */
  assistant(text: string): void;
  /** 错误行 */
  error(text: string): void;
}

export interface CommandDeps {
  session: AgentSession;
  skills: SkillDefinition[];
  /** 自定义斜杠命令（用户/项目/插件；内置命令之后、技能映射之前匹配） */
  commands: CommandDefinition[];
  /** 会话工作目录（插件发现与市场相对路径解析） */
  cwd: string;
  /** 家目录 ~（插件市场落在 <home>/.wcode/plugins；测试注入隔离，缺省 homedir()） */
  homeDir?: string;
  config: WcodeConfig;
  /** 当前激活 provider（/btw 直答；/model 切换后由命令层同步替换） */
  provider: ModelProvider;
  /** /model 切换时按新模型名创建 provider（组合根注入 createProvider） */
  createModelProvider(model: string): Promise<ModelProvider>;
  /**
   * /model：列出当前 provider 端点的可用模型。
   * 不支持或请求失败返回 null（命令层降级为手输模型名）。
   */
  listModels(): Promise<string[] | null>;
  /** /btw 直答的流式事件通道（AgentHost 接口，非 UI 类型） */
  host: AgentHost;
  /** /btw 的中断控制器；Ctrl+C 时由 bin 一并 abort */
  btwAbort: { current: AbortController | null };
  /** /reload：重建运行时快照（配置/技能/子 Agent/命令/插件/注册表/权限引擎/系统提示） */
  reloadRuntime(): Promise<{
    config: WcodeConfig;
    skills: SkillDefinition[];
    commands: CommandDefinition[];
    plugins: DiscoveredPlugin[];
    problems: string[];
    registry: ToolRegistry;
  }>;
  /** /mcp：当前工具注册表（/reload 后由命令层同步替换） */
  registry: ToolRegistry;
  /** /resume：会话存储驱动（列表 / 搜索 / 打开 / 统计） */
  sessions: SessionDriver;
  /**
   * /resume <序号> 的解析上下文：最近一次展示的会话列表
   * （/resume 无参或 /sessions 搜索时更新），使搜索结果可以直接按序号恢复
   */
  lastListing?: SessionSummary[];
  /** 打开 store / 日志需要 */
  log: Logger;
}

export type SlashOutcome =
  | { kind: "handled" }
  | { kind: "forward"; text: string };

const HELP_TEXT = [
  "可用命令：",
  "",
  "- **/help** — 显示本帮助",
  "- **/model** — 列出 provider 可用模型；**/model** <序号|名称> 切换（会话内生效）",
  "- **/skill** — 列出可用技能",
  "- **/skill** <名称> [参数] — 调用技能（等价于直接输入 /技能名）",
  "- **/init** — 探索仓库并生成/完善 AGENTS.md",
  "- **/btw** <问题> — 顺带一问：单轮直答，不进入任务上下文",
  "- **/compact** — 立即压缩上下文（结构化摘要 + 最近消息）",
  "- **/goal** [目标] — 查看/设定任务目标（压缩后依然有效）；**/goal clear** 清除",
  "- **/plugin** — 插件管理：list / install / uninstall / enable / disable / market（详见 /plugin）",
  "- **/reload** — 热重载配置、权限规则、hooks、技能、自定义命令与插件（无需重启）",
  "- **/mcp** [名称] — 查看 MCP 服务器连接状态与工具（/reload 重试连接）",
  "- **/sessions** [关键词] — 无参列出最近会话；带关键词跨会话搜索消息（/resume <序号> 恢复命中会话）",
  "- **/stats** — 本项目的会话数 / 消息数 / 累计 token 用量",
  "- **/resume** [序号] — 列出并恢复历史会话",
  "- **/quit**、**/exit** — 退出 wcode",
  "",
  "自定义命令：~/.wcode/commands/<名>.md 或 .wcode/commands/<名>.md（frontmatter 写 description，正文用 $ARGUMENTS/$1 接参数），插件命令以「插件名:命令名」提供。",
  "",
  "优先级：内置命令 > 自定义命令 > 技能映射。",
].join("\n");

const INIT_PROMPT = [
  "请为本项目生成或完善根目录的 AGENTS.md（Agent 长期指令文件）：",
  "",
  "1. 先探索仓库：读 package.json / README / 关键目录结构，识别技术栈、目录布局、构建/测试/lint 命令。",
  "2. 若已存在 AGENTS.md，先 read 再在其基础上补充完善，保留既有约定；不存在则新建。",
  "3. 内容精炼、可执行：项目结构、常用命令、代码风格与约定、注意事项；不要写成百科。",
  "4. 用 write 工具写入 AGENTS.md，完成后简要汇报写了哪些板块。",
].join("\n");

const BTW_SYSTEM =
  "你是 wcode 终端编程助手的「顺带一问」模式。用户在主任务之外问一个独立小问题：" +
  "直接、简洁地回答（可用 markdown），不要展开无关内容，不要试图调用工具。";

/** /btw 单轮直答：绕过会话与工具，回答不进入任务上下文 */
async function btwAnswer(question: string, deps: CommandDeps): Promise<void> {
  const ctrl = new AbortController();
  deps.btwAbort.current = ctrl;
  const req: ModelRequest = {
    system: BTW_SYSTEM,
    messages: [{ role: "user", content: question }],
    tools: [],
    maxTokens: 2048,
    signal: ctrl.signal,
  };
  let text = "";
  let response: string | undefined;
  try {
    for await (const ev of deps.provider.stream(req)) {
      if (ev.type === "text_delta") text += ev.text;
      else response = ev.response.text;
    }
  } catch (err) {
    if (isAbortedError(err)) {
      deps.host.emit({ type: "error", message: "已中断" });
      return;
    }
    throw err;
  } finally {
    deps.btwAbort.current = null;
  }
  const answer = response ?? text;
  // 走 text_delta 流式渲染；无增量时补发一次，setBusy(false) 时统一落入历史
  if (answer && !text) deps.host.emit({ type: "text_delta", text: answer });
  else if (!answer) deps.host.emit({ type: "error", message: "（/btw 无输出）" });
}

function skillCatalog(skills: SkillDefinition[]): string {
  return skills
    .map((s) => `- **${s.name}**（${s.source}）— ${s.description || "（无描述）"}`)
    .join("\n");
}

/**
 * /model 展示与序号共用的模型清单（火山等端点会返回全量模型，
 * 其中 embedding/语音/视频类确定不能当编码模型）：剔除后去重、按名称排序。
 * 过滤只影响列表展示与序号选择；/model <名称> 手输不受限。
 */
export function displayModels(models: string[]): string[] {
  const NON_CHAT =
    /(embedding|rerank|moderation|pretrain|seaweed|seedance|seedream|tts|asr|voice|whisper|speech)/i;
  return [...new Set(models.filter((m) => !NON_CHAT.test(m)))].sort((a, b) =>
    a.localeCompare(b),
  );
}

interface McpServerStatus {
  name: string;
  command: string;
  args: string[];
  /** 注册表里有 mcp:<name> source 即视为已连接（连接失败时降级跳过不注册） */
  connected: boolean;
  /** 去掉 mcp__<server>__ 前缀的短工具名 */
  tools: string[];
}

function mcpServerStatuses(deps: CommandDeps): McpServerStatus[] {
  const sourceIds = new Set(deps.registry.sourcesOf().map((s) => s.id));
  return Object.entries(deps.config.mcpServers ?? {}).map(([name, cfg]) => {
    // 插件命名空间键（plugin:插件:服务）的工具名已消毒，回查需同一规则
    const prefix = `mcp__${name.replace(/[^a-zA-Z0-9_-]/g, "_")}__`;
    const tools = deps.registry
      .list()
      .filter((t) => t.name.startsWith(prefix))
      .map((t) => t.name.slice(prefix.length));
    return {
      name,
      // http/sse 型没有 command：命令位展示 url（schema refine 保证二者必有其一）
      command: cfg.command ?? cfg.url ?? "",
      args: cfg.args ?? [],
      connected: sourceIds.has(`mcp:${name}`),
      tools,
    };
  });
}

/**
 * 斜杠命令层（M2）：内置命令本地处理，其余映射为 skill 调用或原样转发。
 * 内置命令优先于同名技能。
 */
export async function handleSlashCommand(
  raw: string,
  deps: CommandDeps,
  sink: CommandSink,
): Promise<SlashOutcome> {
  const text = raw.trim();
  if (!text.startsWith("/")) return { kind: "forward", text: raw };

  // 命令名允许 : 与 .（插件命令「插件名:命令名」）；内置命令优先于一切
  const m = /^\/([a-z0-9][a-z0-9._:-]*)(?:\s+([\s\S]+))?$/i.exec(text);
  if (!m) return { kind: "forward", text: raw };
  const name = (m[1] ?? "").toLowerCase();
  const args = m[2] ?? "";

  switch (name) {
    case "help": {
      sink.assistant(HELP_TEXT);
      return { kind: "handled" };
    }

    case "model": {
      if (!args) {
        const models = await deps.listModels();
        if (models && models.length > 0) {
          const display = displayModels(models);
          if (display.length === 0) {
            sink.note(
              `当前模型: ${deps.config.model}（provider: ${deps.config.activeProvider}）。` +
                `端点返回 ${models.length} 个模型但均非对话类，可直接 /model <名称> 切换。`,
            );
            return { kind: "handled" };
          }
          const lines = display.map(
            (m, i) => `${i + 1}. ${m}${m === deps.config.model ? "  ← 当前" : ""}`,
          );
          const omitted =
            display.length < models.length
              ? `\n\n（已隐藏 ${models.length - display.length} 个非对话类模型，如 embedding/语音；/model <名称> 可切换任意模型）`
              : "";
          sink.assistant(
            `当前模型: ${deps.config.model}（provider: ${deps.config.activeProvider}）\n\n` +
              `可用模型（/model <序号> 或 /model <名称> 切换）：\n${lines.join("\n")}` +
              omitted,
          );
        } else {
          sink.note(
            `当前模型: ${deps.config.model}（provider: ${deps.config.activeProvider}）。` +
              "未能获取该端点的模型列表（不支持或请求失败），可直接 /model <名称> 切换。",
          );
        }
        return { kind: "handled" };
      }
      // 解析目标：纯数字按列表序号取（与展示同一份过滤排序清单），其余按模型名直切
      let target = args.trim();
      if (/^\d+$/.test(target)) {
        const models = await deps.listModels();
        const picked = models ? displayModels(models)[Number.parseInt(target, 10) - 1] : undefined;
        if (!picked) {
          sink.error(
            models && models.length > 0
              ? `序号超出范围。直接输入 /model 查看列表。`
              : "当前无法获取模型列表，请直接使用 /model <名称> 切换。",
          );
          return { kind: "handled" };
        }
        target = picked;
      }
      try {
        const provider = await deps.createModelProvider(target);
        deps.session.setProvider(provider);
        deps.provider = provider; // /btw 直答等命令跟随新 provider
        deps.config.model = target;
        sink.note(`已切换模型: ${target}（会话内生效）`);
      } catch (err) {
        sink.error(`切换模型失败: ${errorMessage(err)}`);
      }
      return { kind: "handled" };
    }

    case "skill": {
      if (!args) {
        if (deps.skills.length === 0) {
          sink.note(
            "当前没有可用技能。在 ~/.wcode/skills/<名>/SKILL.md 或 .wcode/skills/<名>/SKILL.md 创建" +
              "（frontmatter 写 name/description，正文是指令）。",
          );
        } else {
          sink.assistant(`可用技能：\n\n${skillCatalog(deps.skills)}`);
        }
        return { kind: "handled" };
      }
      const [skillName, ...rest] = args.split(/\s+/);
      const params = rest.join(" ");
      const skill = deps.skills.find((s) => s.name === skillName);
      if (!skill) {
        const catalog =
          deps.skills.map((s) => s.name).join("、") || "（当前没有可用技能）";
        sink.error(`未知技能 "${skillName}"。可用技能: ${catalog}`);
        return { kind: "handled" };
      }
      return {
        kind: "forward",
        text:
          `请使用 skill 工具加载技能 "${skill.name}"` +
          `${params ? `，附加参数：${params}` : ""}，然后严格按技能指令执行。`,
      };
    }

    case "init":
      return { kind: "forward", text: INIT_PROMPT };

    case "btw": {
      if (!args) {
        sink.error("用法: /btw <问题>（单轮直答，不进入任务上下文）");
        return { kind: "handled" };
      }
      await btwAnswer(args, deps);
      return { kind: "handled" };
    }

    case "compact": {
      try {
        const note = await deps.session.compactNow();
        sink.note(note);
      } catch (err) {
        sink.error(`压缩失败: ${errorMessage(err)}`);
      }
      return { kind: "handled" };
    }

    case "goal": {
      if (!args) {
        const goal = deps.session.getGoal();
        sink.note(
          goal
            ? `当前目标: ${goal}`
            : "未设定目标。用法: /goal <目标描述>（压缩上下文后依然有效），/goal clear 清除。",
        );
        return { kind: "handled" };
      }
      if (args.toLowerCase() === "clear") {
        deps.session.setGoal(undefined);
        sink.note("已清除目标。");
        return { kind: "handled" };
      }
      deps.session.setGoal(args);
      sink.note(`已设定目标（压缩上下文后依然有效）：\n${args}`);
      return { kind: "handled" };
    }

    case "mcp": {
      const servers = mcpServerStatuses(deps);
      if (servers.length === 0) {
        sink.note(
          "未配置 MCP 服务器。在 ~/.wcode/settings.json 或项目 .wcode/settings.json 的 mcpServers 中添加，例如：\n" +
            '{ "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/tmp"] } } }\n' +
            "保存后输入 /reload 生效。",
        );
        return { kind: "handled" };
      }
      const query = args.trim();
      if (query) {
        const target = servers.find((s) => s.name === query);
        if (!target) {
          sink.error(
            `未知 MCP 服务器 "${query}"。已配置: ${servers.map((s) => s.name).join("、")}`,
          );
          return { kind: "handled" };
        }
        const toolLines =
          target.tools.length > 0
            ? target.tools.map((t) => `  - ${t}`).join("\n")
            : "  （无工具）";
        sink.assistant(
          `MCP 服务器「${target.name}」\n\n` +
            `- 命令: \`${target.command}${target.args.length ? " " + target.args.join(" ") : ""}\`\n` +
            `- 状态: ${target.connected ? "已连接" : "连接失败（修复配置后 /reload 重试）"}\n` +
            `- 工具（${target.tools.length} 个）:\n${toolLines}`,
        );
        return { kind: "handled" };
      }
      const lines = servers.map((s) => {
        const cmd = `${s.command}${s.args.length ? " " + s.args.join(" ") : ""}`;
        const status = s.connected
          ? `✓ ${s.tools.length} 个工具`
          : "✗ 连接失败（/reload 重试）";
        return `- ${s.name}（${status}）— \`${cmd}\``;
      });
      sink.assistant(`MCP 服务器（${servers.length} 个）：\n\n${lines.join("\n")}`);
      return { kind: "handled" };
    }

    case "sessions": {
      const kw = args.trim();
      if (!kw) {
        // 无参 = 最近会话列表（与 /resume 无参一致）
        const sessions = await deps.sessions.listRecent();
        if (sessions.length === 0) {
          sink.note("该目录下没有历史会话记录。");
          return { kind: "handled" };
        }
        deps.lastListing = sessions;
        const lines = sessions.map(
          (s, i) =>
            `${i + 1}. ${s.sessionId} · ${s.messageCount} 条消息 · ${s.preview || "（无预览）"}`,
        );
        sink.assistant(
          `最近的会话（/resume <序号> 恢复，当前会话也在列表中）：\n\n${lines.join("\n")}`,
        );
        return { kind: "handled" };
      }
      const hits = await deps.sessions.search(kw);
      if (hits.length === 0) {
        sink.note(`没有会话包含「${kw}」。`);
        return { kind: "handled" };
      }
      // 按会话分组展示；序号 = 分组序号，/resume <序号> 直接恢复对应会话
      const groups = new Map<string, { summary: SessionSummary; hits: string[] }>();
      for (const h of hits) {
        let g = groups.get(h.sessionId);
        if (!g) {
          g = {
            summary: {
              sessionId: h.sessionId,
              createdAt: h.createdAt,
              messageCount: h.messageCount,
              preview: h.excerpt,
            },
            hits: [],
          };
          groups.set(h.sessionId, g);
        }
        g.hits.push(`   [${h.role} #${h.messageIndex}] ${h.excerpt}`);
      }
      const list = [...groups.values()];
      deps.lastListing = list.map((g) => g.summary);
      const blocks = list.map((g, i) => {
        const date = g.summary.createdAt ? ` · ${g.summary.createdAt.slice(0, 10)}` : "";
        return [`${i + 1}. ${g.summary.sessionId} · ${g.summary.messageCount} 条消息${date}`, ...g.hits].join("\n");
      });
      sink.assistant(
        `包含「${kw}」的会话（${list.length} 个，/resume <序号> 恢复）：\n\n${blocks.join("\n")}`,
      );
      return { kind: "handled" };
    }

    case "stats": {
      const s = await deps.sessions.stats();
      sink.note(
        `本项目存储：${s.sessionCount} 个会话 · ${s.messageCount} 条消息 · ` +
          `累计输入 ${s.inputTokens} / 输出 ${s.outputTokens} token`,
      );
      return { kind: "handled" };
    }

    case "reload": {
      try {
        const snap = await deps.reloadRuntime();
        // 后续命令（/skill、/model、/mcp 等）使用重载后的配置、技能、命令与注册表
        deps.config = snap.config;
        deps.skills = snap.skills;
        deps.commands = snap.commands;
        deps.registry = snap.registry;
        const warnings =
          snap.problems.length > 0 ? `；警告: ${snap.problems.join("；")}` : "";
        sink.note(
          `已热重载：配置、权限规则、hooks、技能（${snap.skills.length} 个）、` +
            `自定义命令（${snap.commands.length} 个）、子 Agent 定义、插件（${snap.plugins.length} 个）。` +
            "provider 与 MCP 连接保持不变" + warnings,
        );
      } catch (err) {
        sink.error(`重载失败: ${errorMessage(err)}`);
      }
      return { kind: "handled" };
    }

    case "resume": {
      const sessions = deps.lastListing ?? (await deps.sessions.listRecent());
      if (sessions.length === 0) {
        sink.note("该目录下没有历史会话记录。");
        return { kind: "handled" };
      }
      if (!args) {
        deps.lastListing = sessions; // 序号上下文：/resume <序号> 与本次列表对应
        const lines = sessions.map(
          (s, i) =>
            `${i + 1}. ${s.sessionId} · ${s.messageCount} 条消息 · ${s.preview || "（无预览）"}`,
        );
        sink.assistant(
          `最近的会话（/resume <序号> 恢复，当前会话也在列表中）：\n\n${lines.join("\n")}`,
        );
        return { kind: "handled" };
      }
      const idx = Number.parseInt(args, 10);
      if (!Number.isInteger(idx) || idx < 1 || idx > sessions.length) {
        sink.error(`序号需为 1-${sessions.length}。直接输入 /resume 查看列表。`);
        return { kind: "handled" };
      }
      const target = sessions[idx - 1];
      if (!target) {
        sink.error(`序号需为 1-${sessions.length}。直接输入 /resume 查看列表。`);
        return { kind: "handled" };
      }
      try {
        const store = await deps.sessions.open(target.sessionId);
        const messages = messagesFromSessionLines(await store.load());
        deps.session.applyResume(store, messages);
        sink.note(
          `已恢复会话 ${target.sessionId}（${messages.length} 条消息）。` +
            "后续对话将写入该会话记录；当前会话的内容仍保留在其原记录中。",
        );
      } catch (err) {
        sink.error(`恢复会话失败: ${errorMessage(err)}`);
      }
      return { kind: "handled" };
    }

    case "plugin":
      return handlePluginCommand(args, deps, sink);

    default: {
      // 自定义命令（用户/项目/插件）：优先于技能映射（内置命令已在 switch 命中）
      const lookup = findCommand(deps.commands, name);
      if (lookup.problem) {
        sink.error(lookup.problem);
        return { kind: "handled" };
      }
      if (lookup.command) {
        const expanded = expandCommandBody(lookup.command.body, args);
        return { kind: "forward", text: expanded };
      }
      const mapped = mapSlashCommand(text, deps.skills);
      if (mapped !== text) return { kind: "forward", text: mapped };
      sink.error(`未知命令 "/${name}"。输入 /help 查看可用命令。`);
      return { kind: "handled" };
    }
  }
}

/** 「name@market」或裸「name」解析；无市场时返回 undefined 由调用方跨市场查找 */
function parsePluginRef(ref: string): { name: string; market?: string } {
  const at = ref.lastIndexOf("@");
  if (at > 0) return { name: ref.slice(0, at), market: ref.slice(at + 1) };
  return { name: ref };
}

/** 插件管理（对齐 zcode 插件语义）：安装/卸载/启停/市场管理，变更后 /reload 热应用 */
async function handlePluginCommand(
  args: string,
  deps: CommandDeps,
  sink: CommandSink,
): Promise<SlashOutcome> {
  const home = deps.homeDir ?? homedir();
  const pluginsDir = defaultPluginsDir(join(home, ".wcode"));
  const [sub, ...rest] = args.trim().split(/\s+/);
  const arg = rest.join(" ").trim();
  const apply = async (): Promise<void> => {
    const snap = await deps.reloadRuntime();
    deps.config = snap.config;
    deps.skills = snap.skills;
    deps.commands = snap.commands;
    deps.registry = snap.registry;
  };
  try {
    if (!sub || sub === "list") {
      const { plugins } = await discoverForList(deps);
      if (plugins.length === 0) {
        sink.note(
          "尚未安装插件。用法：/plugin market add <本地目录|owner/repo|git url> 添加市场，" +
            "然后 /plugin install <插件名>[@市场]。",
        );
        return { kind: "handled" };
      }
      const lines = plugins.map((p) => {
        const state = p.enabled ? "已启用" : "已停用";
        const from = p.marketplace === BUILTIN_MARKET_ID ? "内置" : `来自 ${p.marketplace}`;
        const counts =
          `技能 ${p.skills.length} · 命令 ${p.commands.length} · 子Agent ${p.agents.length} · MCP ${Object.keys(p.mcpServers).length}`;
        return `- **${p.name}@${p.marketplace}** v${p.version}（${state}，${from}）— ${p.description ?? "（无描述）"}\n  ${counts}`;
      });
      sink.assistant(`已安装插件（${plugins.length} 个）：\n\n${lines.join("\n")}`);
      return { kind: "handled" };
    }

    if (sub === "install") {
      if (!arg) {
        sink.error("用法: /plugin install <插件名>[@市场]");
        return { kind: "handled" };
      }
      const { name, market } = parsePluginRef(arg);
      const marketId = market ?? (await locatePluginMarket(name, pluginsDir));
      const target = await installPlugin({ marketId, pluginName: name, pluginsDir, cwd: deps.cwd });
      await apply();
      sink.note(
        `已安装 ${name}@${marketId} v${target.version}` +
          (target.problems.length > 0 ? `；警告: ${target.problems.join("；")}` : "") +
          "。技能/命令/MCP 已生效（hooks 对新建会话生效）。",
      );
      return { kind: "handled" };
    }

    if (sub === "uninstall") {
      if (!arg) {
        sink.error("用法: /plugin uninstall <插件名>[@市场]");
        return { kind: "handled" };
      }
      const { name, market } = parsePluginRef(arg);
      const marketId = market ?? (await locateInstalledMarket(name, deps));
      await uninstallPlugin({ marketId, pluginName: name, pluginsDir });
      // 启停标记一并清除（重装后默认启用）；内置插件记屏蔽标记，升级不装回
      await patchUserSettings(
        (obj) => {
          const prev = (obj.plugins as { enabled?: Record<string, boolean> } | undefined) ?? {};
          const enabled = { ...(prev.enabled ?? {}) };
          delete enabled[pluginKey(name, marketId)];
          const patch: Record<string, unknown> = { ...prev, enabled };
          if (marketId === BUILTIN_MARKET_ID) {
            patch.blockedBuiltins = [
              ...new Set([...((obj.plugins as { blockedBuiltins?: string[] } | undefined)?.blockedBuiltins ?? []), name]),
            ];
          }
          obj.plugins = patch;
        },
        { homeDir: home },
      );
      await apply();
      sink.note(
        `已卸载 ${name}@${marketId}。` +
          (marketId === BUILTIN_MARKET_ID
            ? "（内置插件不会随升级装回；如需恢复，从 ~/.wcode/settings.json 的 plugins.blockedBuiltins 移除该名称）"
            : ""),
      );
      return { kind: "handled" };
    }

    if (sub === "enable" || sub === "disable") {
      if (!arg) {
        sink.error(`用法: /plugin ${sub} <插件名>[@市场]`);
        return { kind: "handled" };
      }
      const { name, market } = parsePluginRef(arg);
      const marketId = market ?? (await locateInstalledMarket(name, deps));
      const enabled = sub === "enable";
      await patchUserSettings(
        (obj) => {
          const prev = (obj.plugins as { enabled?: Record<string, boolean> } | undefined) ?? {};
          obj.plugins = {
            ...prev,
            enabled: { ...(prev.enabled ?? {}), [pluginKey(name, marketId)]: enabled },
          };
        },
        { homeDir: home },
      );
      await apply();
      sink.note(
        `${enabled ? "已启用" : "已停用"} ${name}@${marketId}。` +
          "技能/命令/MCP 即刻生效；hooks 仅对启用后的新会话生效。",
      );
      return { kind: "handled" };
    }

    if (sub === "market") {
      const [op, ...restArgs] = rest;
      const marketArg = restArgs.join(" ").trim();
      if (!op || op === "list") {
        const known = await loadKnownMarketplaces(pluginsDir);
        if (known.marketplaces.length === 0) {
          sink.note(
            "尚未登记插件市场。用法: /plugin market add <本地目录|owner/repo|git url|marketplace.json url>",
          );
          return { kind: "handled" };
        }
        const lines = known.marketplaces.map(
          (m) => `- **${m.id}**（${m.pluginCount ?? "?"} 个插件，来源 ${describeSource(m.source)}）— ${m.description ?? ""}`,
        );
        sink.assistant(`已登记插件市场（${known.marketplaces.length} 个）：\n\n${lines.join("\n")}`);
        return { kind: "handled" };
      }
      if (op === "add") {
        if (!marketArg) {
          sink.error("用法: /plugin market add <本地目录|owner/repo|git url|marketplace.json url>");
          return { kind: "handled" };
        }
        const added = await addMarketplace({ input: marketArg, pluginsDir, cwd: deps.cwd });
        sink.note(`已添加市场 ${added.id}（${added.pluginCount} 个插件）。/plugin install <名称> 安装插件。`);
        return { kind: "handled" };
      }
      if (op === "refresh") {
        if (!marketArg) {
          sink.error("用法: /plugin market refresh <市场id>");
          return { kind: "handled" };
        }
        const refreshed = await refreshMarketplace({ id: marketArg, pluginsDir, cwd: deps.cwd });
        sink.note(`已刷新市场 ${refreshed.id}（${refreshed.pluginCount} 个插件）。已安装版本不变，重装可更新。`);
        return { kind: "handled" };
      }
      if (op === "remove") {
        if (!marketArg) {
          sink.error("用法: /plugin market remove <市场id>");
          return { kind: "handled" };
        }
        await removeMarketplace({ id: marketArg, pluginsDir });
        sink.note(`已移除市场 ${marketArg}（已安装插件保留可用）。`);
        return { kind: "handled" };
      }
      sink.error("用法: /plugin market list|add|refresh|remove");
      return { kind: "handled" };
    }

    sink.error(
      "用法: /plugin list | /plugin install <名>[@市场] | /plugin uninstall <名>[@市场] | " +
        "/plugin enable|disable <名>[@市场] | /plugin market list|add|refresh|remove",
    );
    return { kind: "handled" };
  } catch (err) {
    sink.error(errorMessage(err));
    return { kind: "handled" };
  }
}

/** /plugin list：插件元信息与组件计数（直接重新发现，免维护状态） */
async function discoverForList(
  deps: CommandDeps,
): Promise<{ plugins: DiscoveredPlugin[] }> {
  const res = await discoverInstalledPlugins({
    cwd: deps.cwd,
    homeDir: join(deps.homeDir ?? homedir(), ".wcode"),
    config: deps.config,
  });
  return { plugins: res.plugins };
}

/** 裸插件名 → 所在市场：唯一命中直接用，否则报可行动错误 */
async function locatePluginMarket(name: string, pluginsDir: string): Promise<string> {
  const known = await loadKnownMarketplaces(pluginsDir);
  if (known.marketplaces.length === 0) {
    throw new Error("尚未登记插件市场。先 /plugin market add <目录|owner/repo|git url>。");
  }
  const hits: string[] = [];
  for (const m of known.marketplaces) {
    try {
      const { entries } = await listMarketplacePlugins({ id: m.id, pluginsDir });
      if (entries.some((e) => e.name === name)) hits.push(m.id);
    } catch {
      // 市场物化损坏：跳过，由 refresh 修复
    }
  }
  if (hits.length === 1) return hits[0] ?? "";
  if (hits.length === 0) {
    throw new Error(`已登记的市场里都没有插件 "${name}"。/plugin market list 查看，或确认名称。`);
  }
  throw new Error(`插件 "${name}" 在多个市场存在（${hits.join("、")}），请用 ${name}@市场 指定。`);
}

/** 裸插件名 → 已安装市场（卸载/启停用） */
async function locateInstalledMarket(name: string, deps: CommandDeps): Promise<string> {
  const { plugins } = await discoverForList(deps);
  const hits = plugins.filter((p) => p.name === name);
  const first = hits[0];
  if (hits.length === 1 && first) return first.marketplace;
  if (hits.length === 0) {
    throw new Error(`插件 "${name}" 未安装。/plugin list 查看已安装插件。`);
  }
  throw new Error(`插件 "${name}" 从多个市场安装（${hits.map((h) => h.marketplace).join("、")}），请用 ${name}@市场 指定。`);
}
