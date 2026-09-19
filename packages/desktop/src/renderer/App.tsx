import { useEffect, useMemo, useRef, useState } from "react";
import type { PermissionDecision } from "@wcode/core";
import {
  ALL_THINKING_LEVELS,
  type PermissionAsk,
  type RuntimeInfo,
  type SearchHitEntry,
  type ModelCatalogGroup,
} from "../shared/protocol";
import type { MentionItem, MentionTrigger } from "./components/Composer";
import { ChatPane, type PaneState } from "./components/ChatPane";
import type { ComposerCommand } from "./components/Composer";
import { AutomationPage } from "./components/AutomationPage";
import { MediaPage } from "./components/MediaPage";
import { PluginsPage } from "./components/PluginsPage";
import { Rail, type Theme, type View } from "./components/Rail";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { UsagePage } from "./components/UsagePage";
import { createMockBridge } from "./mock-bridge";
import {
  addAttachments,
  addQuote,
  addUserItem,
  applyEvent,
  composeWithQuotes,
  decidePermission,
  emptyUiState,
  fileAttachmentsFromPaths,
  itemsFromMessages,
  pushPermission,
  textAttachmentFromPaste,
} from "./state";

export function App() {
  const bridge = useMemo(() => {
    if (window.wcode) return window.wcode;
    console.warn("[wcode] 未检测到 Electron 桥，进入浏览器预览模式");
    return createMockBridge();
  }, []);
  const [info, setInfo] = useState<RuntimeInfo | null>(null);
  const [view, setView] = useState<View>("chat");
  const [panes, setPanes] = useState<PaneState[]>([]);
  const [activePane, setActivePane] = useState(0);
  const [catalog, setCatalog] = useState<ModelCatalogGroup[]>([]);
  const [navOpen, setNavOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchHitEntry[] | null>(null);
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("wcode-theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("wcode-theme", theme);
  }, [theme]);

  const panesRef = useRef(panes);
  panesRef.current = panes;

  // 运行中的会话 id（分屏时可同时多个）：侧栏当前会话行首的圈圈动画依据
  const runningIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of panes) {
      if (p.sessionId && p.ui.running) ids.add(p.sessionId);
    }
    return ids;
  }, [panes]);

  useEffect(() => {
    void bridge.info().then(setInfo);
    const offs = [
      bridge.onEvent((sessionId, ev) => {
        setPanes((ps) =>
          ps.map((p) => (p.sessionId === sessionId ? { ...p, ui: applyEvent(p.ui, ev) } : p)),
        );
      }),
      bridge.onPermission((ask: PermissionAsk) => {
        setPanes((ps) =>
          ps.map((p) =>
            p.sessionId === ask.sessionId ? { ...p, ui: pushPermission(p.ui, ask) } : p,
          ),
        );
      }),
      bridge.onInfo(setInfo),
    ];
    return () => offs.forEach((off) => off());
  }, [bridge]);

  // 首屏：空面板，首个会话延迟到首次发送时创建（不在历史里堆积空会话）
  useEffect(() => {
    if (info && panesRef.current.length === 0) {
      setPanes([{ sessionId: null, cwd: info.currentCwd, ui: emptyUiState }]);
    }
  }, [info, bridge]);

  // 模型目录：info 每次推送后刷新（增删模型/切换都会触发）
  useEffect(() => {
    if (!info) return;
    bridge
      .listModelCatalog()
      .then(setCatalog)
      .catch(() => {});
  }, [info, bridge]);

  const mutatePane = (idx: number, fn: (p: PaneState) => PaneState) =>
    setPanes((ps) => ps.map((p, i) => (i === idx ? fn(p) : p)));

  /** 面板内联提示（替代 window.alert：原生弹窗会阻塞渲染进程且可能不可见） */
  const pushNotice = (idx: number, level: "info" | "error", msg: string) =>
    mutatePane(idx, (p) => ({
      ...p,
      ui: {
        ...p.ui,
        items: [
          ...p.ui.items,
          { kind: "notice" as const, id: `notice-${level}-${p.ui.items.length}`, level, text: msg },
        ],
      },
    }));

  const send = async (idx: number, text: string) => {
    const pane = panesRef.current[idx];
    if (!pane) return;
    // 划选引用并入发送文本、附件走主进程标注块，二者发送后清空：
    // 用户气泡与模型上下文各取所需，输入框回到空态
    const full = composeWithQuotes(pane.ui.quotes, text);
    const attachments = pane.ui.attachments.map((a) =>
      a.kind === "file"
        ? { name: a.name, kind: "file" as const, path: a.path }
        : { name: a.name, kind: "text" as const, content: a.content },
    );
    mutatePane(idx, (p) => ({
      ...p,
      ui: addUserItem({ ...p.ui, quotes: [], attachments: [] }, full),
    }));
    let sessionId = pane.sessionId;
    if (!sessionId) {
      const created = await bridge.newSession(pane.cwd);
      sessionId = created.sessionId;
      mutatePane(idx, (p) => ({ ...p, sessionId: created.sessionId, cwd: created.cwd }));
    }
    await bridge.send(sessionId, full, attachments);
  };

  /** 划选引用追加到输入框：超限以内联错误提示呈现，不截断不挤掉已有引用 */
  const addQuoteToPane = (idx: number, text: string) => {
    const pane = panesRef.current[idx];
    if (!pane) return;
    const res = addQuote(pane.ui.quotes, text);
    if (!res.ok) {
      pushNotice(idx, "error", res.error);
      return;
    }
    mutatePane(idx, (p) => ({ ...p, ui: { ...p.ui, quotes: res.quotes } }));
  };

  const removeQuote = (idx: number, id: string) =>
    mutatePane(idx, (p) => ({
      ...p,
      ui: { ...p.ui, quotes: p.ui.quotes.filter((q) => q.id !== id) },
    }));

  /** + 附件：文件对话框多选，全有或全无（超限报错不部分接收） */
  const pickAttachments = async (idx: number) => {
    const pane = panesRef.current[idx];
    if (!pane) return;
    const paths = await bridge.pickFiles().catch(() => [] as string[]);
    const res = addAttachments(pane.ui.attachments, fileAttachmentsFromPaths(paths));
    if (!res.ok) {
      pushNotice(idx, "error", res.error);
      return;
    }
    mutatePane(idx, (p) => ({ ...p, ui: { ...p.ui, attachments: res.attachments } }));
  };

  /** 粘贴长文转附件：输入框不刷屏，完整内容随发送进入上下文 */
  const pasteToAttachment = (idx: number, text: string) => {
    const pane = panesRef.current[idx];
    if (!pane) return;
    const res = addAttachments(pane.ui.attachments, [textAttachmentFromPaste(text)]);
    if (!res.ok) {
      pushNotice(idx, "error", res.error);
      return;
    }
    mutatePane(idx, (p) => ({ ...p, ui: { ...p.ui, attachments: res.attachments } }));
  };

  const removeAttachment = (idx: number, id: string) =>
    mutatePane(idx, (p) => ({
      ...p,
      ui: { ...p.ui, attachments: p.ui.attachments.filter((a) => a.id !== id) },
    }));

  const fork = async (idx: number, userTurn: number) => {
    const pane = panesRef.current[idx];
    if (!pane?.sessionId) return;
    const res = await bridge.forkSession(pane.cwd, pane.sessionId, userTurn);
    mutatePane(idx, () => ({
      sessionId: res.sessionId,
      cwd: pane.cwd,
      ui: { items: itemsFromMessages(res.messages), usage: null, running: false, runningSince: null, quotes: [], attachments: [] },
    }));
  };

  /** 检查点原地回退：会话 id 不变，丢弃该轮次之后的内容（有确认） */
  const rollback = async (idx: number, userTurn: number) => {
    const pane = panesRef.current[idx];
    if (!pane?.sessionId) return;
    if (!window.confirm("回退到这条消息之前？之后的内容将从当前会话中移除（分叉不受影响）。")) {
      return;
    }
    const res = await bridge.rollbackSession(pane.cwd, pane.sessionId, userTurn);
    mutatePane(idx, () => ({
      sessionId: res.sessionId,
      cwd: pane.cwd,
      ui: { items: itemsFromMessages(res.messages), usage: null, running: false, runningSince: null, quotes: [], attachments: [] },
    }));
  };

  const openSession = async (cwd: string, sessionId: string) => {
    const res = await bridge.openSession(cwd, sessionId);
    mutatePane(activePane, () => ({
      sessionId: res.sessionId,
      cwd,
      ui: { items: itemsFromMessages(res.messages), usage: null, running: false, runningSince: null, quotes: [], attachments: [] },
    }));
    setView("chat");
    setNavOpen(false);
    setSearchResults(null);
  };

  /** 置顶 / 取消置顶（写用户级配置，失败时静默——下一次 info 推送会还原状态） */
  const togglePin = async (sessionId: string, pinned: boolean) => {
    try {
      await bridge.setSessionPinned(sessionId, pinned);
    } catch {
      // 忽略：置顶失败不打断主流程
    }
  };

  /** 删除会话：确认后删存储，引用它的分屏面板一并回到新会话态 */
  const deleteSession = async (cwd: string, sessionId: string, title: string) => {
    if (!window.confirm(`删除会话「${title}」？消息记录将从磁盘清除，不可恢复。`)) {
      return;
    }
    try {
      await bridge.deleteSession(cwd, sessionId);
    } catch (e) {
      pushNotice(activePane, "error", e instanceof Error ? e.message : String(e));
      return;
    }
    setPanes((ps) =>
      ps.map((p) =>
        p.sessionId === sessionId
          ? { sessionId: null, cwd: p.cwd, ui: emptyUiState }
          : p,
      ),
    );
    setSearchResults(null);
  };

  const doSearch = async (keyword: string) => {
    if (keyword === "") {
      setSearchResults(null);
      return;
    }
    setSearchResults(await bridge.searchSessions(keyword));
  };

  const newChat = () =>
    mutatePane(activePane, () => ({
      sessionId: null,
      cwd: info?.currentCwd ?? "",
      ui: emptyUiState,
    }));

  /** 分屏开关：单面板 → 追加第二面板；双面板 → 收回为第一个面板 */
  const toggleSplit = () => {
    if (panesRef.current.length === 1) {
      setPanes([
        ...panesRef.current,
        { sessionId: null, cwd: info?.currentCwd ?? "", ui: emptyUiState },
      ]);
    } else {
      setPanes(panesRef.current.slice(0, 1));
      setActivePane(0);
    }
  };

  /** 斜杠命令表：输入 / 罗列全部，继续输入按别名/名称过滤，选中即执行 */
  const COMMANDS: ComposerCommand[] = [
    { id: "new", label: "新会话", hint: "清空当前面板", aliases: ["new", "clear"] },
    { id: "compact", label: "压缩上下文", hint: "把当前会话历史摘要化", aliases: ["compact"] },
    { id: "split", label: "分屏开关", hint: "Ctrl+\\", aliases: ["split"] },
    { id: "theme", label: "切换深色 / 浅色主题", aliases: ["theme", "dark", "light"] },
    { id: "model", label: "模型设置", hint: "打开设置页", aliases: ["model"] },
    { id: "thinking-off", label: "思考级别：关闭", aliases: ["thinking-off"] },
    { id: "thinking-low", label: "思考级别：低", aliases: ["thinking-low"] },
    { id: "thinking-medium", label: "思考级别：中", aliases: ["thinking-medium"] },
    { id: "thinking-high", label: "思考级别：高", aliases: ["thinking-high"] },
    { id: "usage", label: "用量统计", aliases: ["stats", "usage"] },
    { id: "automations", label: "定时任务", aliases: ["automations", "cron", "schedule"] },
    { id: "plugins", label: "插件与 MCP", aliases: ["plugins", "mcp"] },
    { id: "media", label: "素材库", aliases: ["media"] },
    { id: "settings", label: "设置", aliases: ["settings"] },
  ];

  /** 当前模型不支持思考时收敛思考命令（与选择器同语义；主进程侧另有守卫兜底） */
  const visibleCommands = COMMANDS.filter(
    (c) => !c.id.startsWith("thinking-") || (info?.thinkingLevels ?? ALL_THINKING_LEVELS).length > 0,
  );

  /** $ / @ / # 引用候选：技能走 info；插件 + 项目文件走 bridge（文件由主进程扫描 cwd）；
   * # 会话取当前项目的会话列表（展开在主进程侧只解析本 cwd 的存储） */
  const resolveMentions = async (
    trigger: MentionTrigger,
    query: string,
  ): Promise<MentionItem[]> => {
    const q = query.trim().toLowerCase();
    if (trigger === "$") {
      return (info?.skills ?? [])
        .filter(
          (s) =>
            q === "" ||
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q),
        )
        .slice(0, 12)
        .map((s) => ({ kind: "skill" as const, name: s.name, detail: s.description, insert: s.name }));
    }
    const cwd = panesRef.current[activePane]?.cwd ?? info?.currentCwd ?? "";
    if (trigger === "#") {
      const out: MentionItem[] = [];
      for (const p of info?.projects ?? []) {
        if (p.cwd !== cwd) continue;
        for (const s of p.sessions) {
          if (out.length >= 12) break;
          // 当前会话的历史本就在上下文里，不进候选
          if (s.id === panesRef.current[activePane]?.sessionId) continue;
          if (q === "" || s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)) {
            out.push({
              kind: "session",
              name: s.title || s.id,
              detail: `${s.messageCount}条 · ${s.time}`,
              insert: s.id,
            });
          }
        }
      }
      return out;
    }
    const files = await bridge.listProjectFiles(cwd, q, 20).catch(() => [] as string[]);
    const plugins = (info?.mcpServers ?? [])
      .filter((m) => q === "" || m.name.toLowerCase().includes(q))
      .map((m) => ({
        kind: "plugin" as const,
        name: m.name,
        detail: m.connected ? "MCP 插件（已连接）" : "MCP 插件",
        insert: m.name,
      }));
    const fileItems = files.map((f) => ({ kind: "file" as const, name: f, detail: "", insert: f }));
    return [...plugins, ...fileItems];
  };

  const runCommand = (id: string) => {    const viewOf: Partial<Record<string, View>> = {
      automations: "automations",
      media: "media",
      plugins: "plugins",
      settings: "settings",
      usage: "usage",
      model: "settings",
    };
    const target = viewOf[id];
    if (target) {
      setView(target);
      setNavOpen(false);
      return;
    }
    switch (id) {
      case "new":
        newChat();
        setNavOpen(false);
        break;
      case "compact": {
        const pane = panesRef.current[activePane];
        if (!pane) break;
        if (!pane.sessionId) {
          pushNotice(activePane, "info", "当前会话还没有消息，无需压缩。");
          break;
        }
        void bridge
          .compactSession(pane.sessionId)
          .catch((e) =>
            pushNotice(
              activePane,
              "error",
              e instanceof Error ? e.message : String(e),
            ),
          );
        break;
      }
      case "split":
        toggleSplit();
        break;
      case "theme":
        setTheme((t) => (t === "dark" ? "light" : "dark"));
        break;
      case "thinking-off":
        void bridge.setThinkingLevel("off");
        break;
      case "thinking-low":
        void bridge.setThinkingLevel("low");
        break;
      case "thinking-medium":
        void bridge.setThinkingLevel("medium");
        break;
      case "thinking-high":
        void bridge.setThinkingLevel("high");
        break;
    }
  };

  // Ctrl+\（macOS ⌘+\）：分屏开关
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
        e.preventDefault();
        toggleSplit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pickFolder = async () => {
    const dir = await bridge.pickFolder();
    if (dir) {
      mutatePane(activePane, () => ({ sessionId: null, cwd: dir, ui: emptyUiState }));
      setView("chat");
    }
  };

  const chatView = (
    <>
      <Sidebar
        info={info}
        activeSessionId={panes[activePane]?.sessionId ?? null}
        runningIds={runningIds}
        searchResults={searchResults}
        split={panes.length > 1}
        onSearch={(kw) => void doSearch(kw)}
        onOpenSession={(cwd, id) => void openSession(cwd, id)}
        onDeleteSession={(cwd, id, title) => void deleteSession(cwd, id, title)}
        onTogglePin={(id, pinned) => void togglePin(id, pinned)}
        onNewChat={newChat}
        onToggleSplit={toggleSplit}
        onPickFolder={() => void pickFolder()}
      />
      <div className={panes.length > 1 ? "panes split" : "panes"}>
        {panes.map((pane, idx) => (
          <ChatPane
            key={idx}
            pane={pane}
            catalog={catalog}
            providerName={info?.providerName ?? ""}
            model={info?.model ?? ""}
            permissionMode={info?.permissionMode ?? "default"}
            thinkingLevel={info?.thinkingLevel ?? "medium"}
            thinkingLevels={info?.thinkingLevels ?? ALL_THINKING_LEVELS}
            active={panes.length > 1 && idx === activePane}
            onActivate={() => setActivePane(idx)}
            onSend={(text) => void send(idx, text)}
            onAddQuote={(t) => addQuoteToPane(idx, t)}
            onRemoveQuote={(id) => removeQuote(idx, id)}
            onPickAttachments={() => void pickAttachments(idx)}
            onPasteToAttachment={(t) => pasteToAttachment(idx, t)}
            onRemoveAttachment={(id) => removeAttachment(idx, id)}
            onAbort={() => bridge.abort(pane.sessionId ?? "")}
            onDecide={(askId, d: PermissionDecision) => {
              mutatePane(idx, (p) => ({ ...p, ui: decidePermission(p.ui, askId, d) }));
              if (pane.sessionId) void bridge.decide(pane.sessionId, askId, d);
            }}
            onFork={(turn) => void fork(idx, turn)}
            onRollback={(turn) => void rollback(idx, turn)}
            onModel={(p, m) => void bridge.selectModel(p, m)}
            onPermissionMode={(m) => bridge.setPermissionMode(m)}
            onThinkingLevel={(l) => bridge.setThinkingLevel(l)}
            onPickFolder={() => void pickFolder()}
            onOpenSettings={() => setView("settings")}
            commands={visibleCommands}
            onCommand={runCommand}
            resolveMentions={resolveMentions}
          />
        ))}
      </div>
    </>
  );

  return (
    <div
      className={
        "app" + (view !== "chat" ? " no-sidebar" : "") + (navOpen ? " sidebar-open" : "")
      }
    >
      <Rail
        view={view}
        theme={theme}
        onView={(v) => {
          setView(v);
          setNavOpen(false);
        }}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      />
      {view === "chat" && chatView}
      <div className="drawer-backdrop" onClick={() => setNavOpen(false)} />
      {view === "chat" ? (
        // ☰ 直接作为网格子元素：桌面端 display:none 不产生第二行（content 空壳
        // 曾把三栏压出窗口底部——网格 5 子元素自动换行成两行）
        <button className="menu-btn" title="会话列表" onClick={() => setNavOpen((v) => !v)}>
          ☰
        </button>
      ) : (
        <div className="content">
          {/* 非会话页统一顶栏：显式返回入口（Rail 的会话图标之外） */}
          <div className="page-top">
            <button className="page-back" title="返回会话" onClick={() => setView("chat")}>
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path
                  d="M14.5 5l-7 7 7 7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              返回会话
            </button>
          </div>
          {view === "plugins" && (
            <PluginsPage
              info={info}
              bridge={bridge}
              onToggleMcp={(name, enabled) => void bridge.setMcpEnabled(name, enabled)}
              onAddMcp={(name, command, args, env) => bridge.addMcpServer(name, command, args, env)}
              onRemoveMcp={(name) => bridge.removeMcpServer(name)}
            />
          )}
          {view === "automations" && <AutomationPage bridge={bridge} info={info} />}
          {view === "media" && <MediaPage />}
          {view === "usage" && <UsagePage info={info} />}
          {view === "settings" && (
            <SettingsPage
              info={info}
              catalog={catalog.filter((g) => {
                if (g.provider === info?.providerName) return true; // 当前使用中的始终展示
                return info?.providers.find((x) => x.name === g.provider)?.enabled !== false;
              })}
              onAddProvider={(name, opts) => bridge.addProvider(name, opts)}
              onRemoveProvider={(name) => void bridge.removeProvider(name)}
              onUpdateProvider={(name, patch) => void bridge.updateProvider(name, patch)}
              onRenameProvider={(o, n) => void bridge.renameProvider(o, n)}
              onSetEnabled={(name, enabled) => void bridge.setProviderEnabled(name, enabled)}
              onSetActive={(name) => void bridge.setActiveProvider(name)}
              onSaveKey={(name, key) => bridge.saveProviderKey(name, key)}
              onGetKey={(name) => bridge.getProviderKey(name)}
              onTestModel={(p, m) => bridge.testModel(p, m)}
              onAddModel={(p, m, c) => bridge.addCatalogModel(p, m, c)}
              onRemoveModel={(p, m) => void bridge.removeCatalogModel(p, m)}
              onUpdateModel={(p, m, patch) => void bridge.updateCatalogModel(p, m, patch)}
            />
          )}
        </div>
      )}
    </div>
  );
}
