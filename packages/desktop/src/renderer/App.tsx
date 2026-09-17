import { useEffect, useMemo, useRef, useState } from "react";
import type { PermissionDecision } from "@wcode/core";
import type { PermissionAsk, RuntimeInfo, SearchHitEntry } from "../shared/protocol";
import { ChatPane, type PaneState } from "./components/ChatPane";
import { AutomationPage } from "./components/AutomationPage";
import { MediaPage } from "./components/MediaPage";
import { PluginsPage } from "./components/PluginsPage";
import { Rail, type Theme, type View } from "./components/Rail";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { UsagePage } from "./components/UsagePage";
import { createMockBridge } from "./mock-bridge";
import {
  addUserItem,
  applyEvent,
  decidePermission,
  emptyUiState,
  itemsFromMessages,
  pushPermission,
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
  const [models, setModels] = useState<string[]>([]);
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
      void bridge.listModels().then(setModels);
    }
  }, [info, bridge]);

  const mutatePane = (idx: number, fn: (p: PaneState) => PaneState) =>
    setPanes((ps) => ps.map((p, i) => (i === idx ? fn(p) : p)));

  const send = async (idx: number, text: string) => {
    const pane = panesRef.current[idx];
    if (!pane) return;
    mutatePane(idx, (p) => ({ ...p, ui: addUserItem(p.ui, text) }));
    let sessionId = pane.sessionId;
    if (!sessionId) {
      const created = await bridge.newSession(pane.cwd);
      sessionId = created.sessionId;
      mutatePane(idx, (p) => ({ ...p, sessionId: created.sessionId, cwd: created.cwd }));
    }
    await bridge.send(sessionId, text);
  };

  const fork = async (idx: number, userTurn: number) => {
    const pane = panesRef.current[idx];
    if (!pane?.sessionId) return;
    const res = await bridge.forkSession(pane.cwd, pane.sessionId, userTurn);
    mutatePane(idx, () => ({
      sessionId: res.sessionId,
      cwd: pane.cwd,
      ui: { items: itemsFromMessages(res.messages), usage: null, running: false },
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
      ui: { items: itemsFromMessages(res.messages), usage: null, running: false },
    }));
  };

  const openSession = async (cwd: string, sessionId: string) => {
    const res = await bridge.openSession(cwd, sessionId);
    mutatePane(activePane, () => ({
      sessionId: res.sessionId,
      cwd,
      ui: { items: itemsFromMessages(res.messages), usage: null, running: false },
    }));
    setView("chat");
    setNavOpen(false);
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
        searchResults={searchResults}
        split={panes.length > 1}
        onSearch={(kw) => void doSearch(kw)}
        onOpenSession={(cwd, id) => void openSession(cwd, id)}
        onNewChat={newChat}
        onToggleSplit={toggleSplit}
        onPickFolder={() => void pickFolder()}
      />
      <div className={panes.length > 1 ? "panes split" : "panes"}>
        {panes.map((pane, idx) => (
          <ChatPane
            key={idx}
            pane={pane}
            models={models}
            model={info?.model ?? ""}
            permissionMode={info?.permissionMode ?? "default"}
            thinkingLevel={info?.thinkingLevel ?? "medium"}
            active={panes.length > 1 && idx === activePane}
            onActivate={() => setActivePane(idx)}
            onSend={(text) => void send(idx, text)}
            onAbort={() => bridge.abort(pane.sessionId ?? "")}
            onDecide={(askId, d: PermissionDecision) => {
              mutatePane(idx, (p) => ({ ...p, ui: decidePermission(p.ui, askId, d) }));
              if (pane.sessionId) void bridge.decide(pane.sessionId, askId, d);
            }}
            onFork={(turn) => void fork(idx, turn)}
            onRollback={(turn) => void rollback(idx, turn)}
            onModel={(m) => bridge.setModel(m)}
            onPermissionMode={(m) => bridge.setPermissionMode(m)}
            onThinkingLevel={(l) => bridge.setThinkingLevel(l)}
            onPickFolder={() => void pickFolder()}
            onOpenSettings={() => setView("settings")}
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
          {view === "plugins" && (
            <PluginsPage
              info={info}
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
              onSaveKey={(name, key) => void bridge.saveProviderKey(name, key)}
              onSetActive={(name) => void bridge.setActiveProvider(name)}
            />
          )}
        </div>
      )}
    </div>
  );
}
