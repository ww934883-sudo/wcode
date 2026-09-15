import { errorMessage, isAbortedError } from "@wcode/core";
import type {
  AgentHost,
  AgentSession,
  Logger,
  ModelProvider,
  ModelRequest,
  SkillDefinition,
  WcodeConfig,
} from "@wcode/core";
import {
  JsonlSessionStore,
  listSessions,
  messagesFromSessionLines,
} from "@wcode/core";
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
  config: WcodeConfig;
  /** 当前激活 provider（/btw 直答） */
  provider: ModelProvider;
  /** /model 切换时按新模型名创建 provider（组合根注入 createProvider） */
  createModelProvider(model: string): Promise<ModelProvider>;
  /** /btw 直答的流式事件通道（AgentHost 接口，非 UI 类型） */
  host: AgentHost;
  /** /btw 的中断控制器；Ctrl+C 时由 bin 一并 abort */
  btwAbort: { current: AbortController | null };
  /** /reload：重建运行时快照（配置/技能/子 Agent/注册表/权限引擎/系统提示） */
  reloadRuntime(): Promise<{
    config: WcodeConfig;
    skills: SkillDefinition[];
    problems: string[];
  }>;
  /** /resume：会话记录目录 */
  sessionsDir: string;
  /** /resume 打开会话 store 需要 */
  log: Logger;
}

export type SlashOutcome =
  | { kind: "handled" }
  | { kind: "forward"; text: string };

const HELP_TEXT = [
  "可用命令：",
  "",
  "- **/help** — 显示本帮助",
  "- **/model** [名称] — 查看或切换模型（会话内生效，重启后回到配置值）",
  "- **/skill** — 列出可用技能",
  "- **/skill** <名称> [参数] — 调用技能（等价于直接输入 /技能名）",
  "- **/init** — 探索仓库并生成/完善 AGENTS.md",
  "- **/btw** <问题> — 顺带一问：单轮直答，不进入任务上下文",
  "- **/compact** — 立即压缩上下文（结构化摘要 + 最近消息）",
  "- **/goal** [目标] — 查看/设定任务目标（压缩后依然有效）；**/goal clear** 清除",
  "- **/reload** — 热重载配置、权限规则、hooks、技能与子 Agent 定义（无需重启）",
  "- **/resume** [序号] — 列出并恢复历史会话",
  "- **/quit**、**/exit** — 退出 wcode",
  "",
  "内置命令优先于同名技能。",
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

  const m = /^\/([a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]+))?$/i.exec(text);
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
        sink.note(
          `当前模型: ${deps.config.model}（provider: ${deps.config.activeProvider}）。` +
            "切换用法: /model <模型名>（会话内生效）",
        );
        return { kind: "handled" };
      }
      try {
        const provider = await deps.createModelProvider(args);
        deps.session.setProvider(provider);
        deps.config.model = args;
        sink.note(`已切换模型: ${args}（会话内生效）`);
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

    case "reload": {
      try {
        const snap = await deps.reloadRuntime();
        // 后续命令（/skill、/model 等）使用重载后的配置与技能
        deps.config = snap.config;
        deps.skills = snap.skills;
        const warnings =
          snap.problems.length > 0 ? `；警告: ${snap.problems.join("；")}` : "";
        sink.note(
          `已热重载：配置、权限规则、hooks、技能（${snap.skills.length} 个）、子 Agent 定义。` +
            "provider 与 MCP 连接保持不变" + warnings,
        );
      } catch (err) {
        sink.error(`重载失败: ${errorMessage(err)}`);
      }
      return { kind: "handled" };
    }

    case "resume": {
      const sessions = await listSessions(deps.sessionsDir);
      if (sessions.length === 0) {
        sink.note("该目录下没有历史会话记录。");
        return { kind: "handled" };
      }
      if (!args) {
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
        const store = new JsonlSessionStore(target.file, deps.log);
        const messages = messagesFromSessionLines(await store.load());
        deps.session.applyResume(store, messages);
        sink.note(
          `已恢复会话 ${target.sessionId}（${messages.length} 条消息）。` +
            "后续对话将写入该会话记录；当前会话的内容仍保留在其原记录文件中。",
        );
      } catch (err) {
        sink.error(`恢复会话失败: ${errorMessage(err)}`);
      }
      return { kind: "handled" };
    }

    default: {
      const mapped = mapSlashCommand(text, deps.skills);
      if (mapped !== text) return { kind: "forward", text: mapped };
      sink.error(`未知命令 "/${name}"。输入 /help 查看可用命令。`);
      return { kind: "handled" };
    }
  }
}
