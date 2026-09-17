import { useEffect, useRef, useState } from "react";
import type { ProjectEntry, RuntimeInfo, SearchHitEntry } from "../../shared/protocol";

function SessionButton({
  entry,
  active,
  onClick,
}: {
  entry: { id: string; title: string; time: string; messageCount: number };
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={active ? "session active" : "session"} onClick={onClick}>
      <span className="session-title">{entry.title}</span>
      <span className="session-meta">
        {entry.time && <span className="session-time">{entry.time}</span>}
        {entry.messageCount > 0 && <span className="session-count">{entry.messageCount}条</span>}
      </span>
    </button>
  );
}

function ProjectGroup({
  project,
  onOpenSession,
  activeId,
  onPickFolder,
}: {
  project: ProjectEntry;
  onOpenSession: (cwd: string, sessionId: string) => void;
  activeId: string | null;
  onPickFolder: () => void;
}) {
  return (
    <div className="project-group">
      <div className="project-head">
        <span className="project-label" title={project.cwd}>
          {project.label}
        </span>
        {project.current && (
          <button className="mini-btn" title="打开其他项目文件夹" onClick={onPickFolder}>
            打开文件夹
          </button>
        )}
      </div>
      <div className="project-sessions">
        {project.sessions.length === 0 ? (
          <div className="session-empty">暂无会话</div>
        ) : (
          project.sessions.map((s) => (
            <SessionButton
              key={s.id}
              entry={s}
              active={s.id === activeId}
              onClick={() => onOpenSession(project.cwd, s.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** 会话侧栏：分屏开关 + 搜索（跨项目）+ 项目分组 + 助理选择 + 状态脚注 */
export function Sidebar({
  info,
  activeSessionId,
  searchResults,
  split,
  onSearch,
  onOpenSession,
  onNewChat,
  onToggleSplit,
  onPickFolder,
  onPersona,
}: {
  info: RuntimeInfo | null;
  activeSessionId: string | null;
  searchResults: SearchHitEntry[] | null;
  split: boolean;
  onSearch: (keyword: string) => void;
  onOpenSession: (cwd: string, sessionId: string) => void;
  onNewChat: () => void;
  onToggleSplit: () => void;
  onPickFolder: () => void;
  onPersona: (name: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const handleInput = (value: string) => {
    setQuery(value);
    if (timer.current) clearTimeout(timer.current);
    if (value.trim() === "") {
      onSearch("");
      return;
    }
    timer.current = setTimeout(() => onSearch(value.trim()), 300);
  };

  const hitProject = (cwd: string): string =>
    cwd.split(/[\\/]/).pop() || cwd;

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <button className="new-chat" onClick={onNewChat}>
          ＋ 新会话
        </button>
        <button
          className={"ghost-btn" + (split ? " on" : "")}
          title={split ? "退出分屏（Ctrl+\\）" : "分屏双会话（Ctrl+\\）"}
          onClick={onToggleSplit}
        >
          ⫿
        </button>
      </div>
      <div className="search">
        <input
          placeholder="搜索所有会话…"
          value={query}
          onChange={(e) => handleInput(e.target.value)}
        />
      </div>

      {searchResults ? (
        <div className="session-list">
          <div className="project-head">
            <span className="project-label">
              搜索结果（{searchResults.length}）
            </span>
          </div>
          {searchResults.length === 0 && (
            <div className="session-empty">没有匹配的会话</div>
          )}
          {searchResults.map((h, i) => (
            <button
              key={`${h.sessionId}-${h.messageIndex}-${i}`}
              className="session search-hit"
              onClick={() => onOpenSession(h.cwd, h.sessionId)}
            >
              <span className="hit-excerpt">{h.excerpt}</span>
              <span className="session-meta">
                <span className="session-time">
                  {hitProject(h.cwd)} · {h.role}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="session-list">
          {(info?.projects ?? []).map((p) => (
            <ProjectGroup
              key={p.cwd}
              project={p}
              onOpenSession={onOpenSession}
              activeId={activeSessionId}
              onPickFolder={onPickFolder}
            />
          ))}
          {info && info.projects.length === 0 && (
            <div className="session-empty">暂无项目</div>
          )}
        </div>
      )}

      <div className="sidebar-foot">
        {(info?.agents.length ?? 0) > 0 && (
          <label className="assistant-row">
            助理
            <select
              className="sel"
              value={info?.persona ?? ""}
              onChange={(e) => onPersona(e.target.value === "" ? null : e.target.value)}
              title="选择助理（新会话生效）"
            >
              <option value="">默认编码助理</option>
              {info?.agents.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {info?.notice && <div className="foot-notice">{info.notice}</div>}
      </div>
    </aside>
  );
}
