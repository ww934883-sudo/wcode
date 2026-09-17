import type { RuntimeInfo } from "../../shared/protocol";

export function PluginsPage({
  info,
  onToggleMcp,
}: {
  info: RuntimeInfo | null;
  onToggleMcp: (name: string, enabled: boolean) => void;
}) {
  return (
    <div className="page">
      <h1>插件</h1>
      <p className="page-sub">
        MCP 服务器与技能（Skills）。启用立即连接（进行中的会话下一次请求即生效）；停用对新建会话生效。
      </p>
      <h2>MCP 服务器</h2>
      {(info?.mcpServers.length ?? 0) === 0 ? (
        <div className="empty-hint">
          尚未配置 MCP 服务器——在 ~/.wcode/settings.json 的 mcpServers 里添加（支持 stdio）。
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
