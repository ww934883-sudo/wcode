import { useState } from "react";
import type { RuntimeInfo } from "../../shared/protocol";

export function PluginsPage({
  info,
  onToggleMcp,
  onAddMcp,
  onRemoveMcp,
}: {
  info: RuntimeInfo | null;
  onToggleMcp: (name: string, enabled: boolean) => void;
  onAddMcp: (
    name: string,
    command: string,
    args: string[],
    env?: Record<string, string>,
  ) => Promise<void>;
  onRemoveMcp: (name: string) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const remove = async (name: string): Promise<void> => {
    setError("");
    setBusy(true);
    try {
      await onRemoveMcp(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <h1>插件</h1>
      <p className="page-sub">
        MCP 服务器与技能（Skills）。启用立即连接（进行中的会话下一次请求即生效）；停用对新建会话生效。
      </p>
      <div className="page-actions">
        <button className="btn primary" onClick={() => setAdding((v) => !v)}>
          {adding ? "收起表单" : "＋ 添加 MCP 服务器"}
        </button>
      </div>
      {error && <div className="foot-notice page-notice">{error}</div>}
      {adding && (
        <McpForm
          onAdd={onAddMcp}
          onDone={() => setAdding(false)}
          onError={(msg) => setError(msg)}
        />
      )}
      <h2>MCP 服务器</h2>
      {(info?.mcpServers.length ?? 0) === 0 ? (
        <div className="empty-hint">
          尚未配置 MCP 服务器——点「添加 MCP 服务器」，或在 ~/.wcode/settings.json 的 mcpServers 里添加（支持 stdio）。
        </div>
      ) : (
        info?.mcpServers.map((m) => (
          <div key={m.name} className="row-card">
            <div className="row-main">
              <span className="row-title">{m.name}</span>
              <span className="row-sub mono">{m.command}</span>
            </div>
            <span className={`chip ${m.connected ? "ok" : ""}`}>
              {m.connected ? "已连接" : "未连接"}
            </span>
            <button className="btn" onClick={() => onToggleMcp(m.name, !m.connected)}>
              {m.connected ? "停用" : "启用"}
            </button>
            <button className="btn danger" disabled={busy} onClick={() => void remove(m.name)}>
              删除
            </button>
          </div>
        ))
      )}
      <h2>技能（Skills）</h2>
      {(info?.skills.length ?? 0) === 0 ? (
        <div className="empty-hint">
          未发现技能——放到 ~/.wcode/skills 或项目 .wcode/skills（SKILL.md + frontmatter）。
        </div>
      ) : (
        info?.skills.map((s) => (
          <div key={s.name} className="row-card">
            <div className="row-main">
              <span className="row-title">{s.name}</span>
              <span className="row-sub">{s.description}</span>
            </div>
            <span className="chip">{s.source === "user" ? "用户级" : "项目级"}</span>
          </div>
        ))
      )}
      {info?.notice && <div className="foot-notice page-notice">{info.notice}</div>}
    </div>
  );
}

/** 新增 MCP 服务器：stdio 命令 + 空白分隔参数 + KEY=VALUE 环境变量（每行一条） */
function McpForm({
  onAdd,
  onDone,
  onError,
}: {
  onAdd: (
    name: string,
    command: string,
    args: string[],
    env?: Record<string, string>,
  ) => Promise<void>;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsLine, setArgsLine] = useState("");
  const [envLines, setEnvLines] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    onError("");
    try {
      const env: Record<string, string> = {};
      for (const line of envLines.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        const eq = t.indexOf("=");
        if (eq <= 0) {
          onError(`环境变量行「${t}」格式应为 KEY=VALUE`);
          return;
        }
        env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
      }
      await onAdd(
        name.trim(),
        command.trim(),
        argsLine.trim() === "" ? [] : argsLine.trim().split(/\s+/),
        Object.keys(env).length > 0 ? env : undefined,
      );
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auto-form">
      <div className="auto-grid">
        <label className="auto-field">
          名称（唯一）
          <input
            value={name}
            placeholder="filesystem"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="auto-field">
          启动命令（stdio）
          <input
            value={command}
            placeholder="npx"
            onChange={(e) => setCommand(e.target.value)}
          />
        </label>
        <label className="auto-field">
          参数（空白分隔）
          <input
            value={argsLine}
            placeholder="-y @modelcontextprotocol/server-filesystem /path"
            onChange={(e) => setArgsLine(e.target.value)}
          />
        </label>
        <label className="auto-field">
          环境变量（每行 KEY=VALUE，可空）
          <textarea
            value={envLines}
            placeholder={"API_TOKEN=xxx\nDEBUG=1"}
            onChange={(e) => setEnvLines(e.target.value)}
          />
        </label>
      </div>
      <div className="auto-form-actions">
        <button className="btn primary" disabled={busy} onClick={() => void submit()}>
          添加并连接
        </button>
      </div>
    </div>
  );
}
