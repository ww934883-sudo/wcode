import { useState } from "react";
import type { RuntimeInfo } from "../../shared/protocol";
import type { WcodeBridge } from "../../shared/protocol";

const SOURCE_LABEL: Record<string, string> = {
  user: "用户级",
  project: "项目级",
  plugin: "插件",
};

export function PluginsPage({
  info,
  bridge,
  onToggleMcp,
  onAddMcp,
  onRemoveMcp,
}: {
  info: RuntimeInfo | null;
  bridge: WcodeBridge;
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
        插件包（技能/命令/子 Agent/hooks/MCP）、MCP 服务器与技能（Skills）。
        启用立即生效（hooks 对新建会话生效）；格式对齐 zcode（.zcode-plugin/plugin.json，兼容 .claude-plugin）。
      </p>

      <PluginsSection info={info} bridge={bridge} error={error} onError={setError} />

      <h2>MCP 服务器</h2>
      <div className="page-actions">
        <button className="btn primary" onClick={() => setAdding((v) => !v)}>
          {adding ? "收起表单" : "＋ 添加 MCP 服务器"}
        </button>
      </div>
      {adding && (
        <McpForm
          onAdd={onAddMcp}
          onDone={() => setAdding(false)}
          onError={(msg) => setError(msg)}
        />
      )}
      {(info?.mcpServers.length ?? 0) === 0 ? (
        <div className="empty-hint">
          尚未配置 MCP 服务器——点「添加 MCP 服务器」，或在 ~/.wcode/settings.json 的 mcpServers 里添加（支持 stdio/http/sse）。
        </div>
      ) : (
        info?.mcpServers.map((m) => (
          <div key={m.name} className="row-card">
            <div className="row-main">
              <span className="row-title mono">{m.name}</span>
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
              <span className="row-title mono">{s.name}</span>
              <span className="row-sub">{s.description}</span>
            </div>
            <span className="chip">{SOURCE_LABEL[s.source] ?? s.source}</span>
          </div>
        ))
      )}
    </div>
  );
}

/** 插件区：已安装列表 + 市场登记 + 市场浏览安装（进行中/错误/主进程提示一律顶部显示） */
function PluginsSection({
  info,
  bridge,
  error,
  onError,
}: {
  info: RuntimeInfo | null;
  bridge: WcodeBridge;
  error: string;
  onError: (msg: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [marketPlugins, setMarketPlugins] = useState<
    Array<{ name: string; description: string | null; version: string | null }>
  >([]);
  /** 进行中操作的提示（git 克隆可能较慢，必须给反馈否则像没反应） */
  const [pending, setPending] = useState("");

  const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
    if (pending) return; // 防双击/并发操作
    onError("");
    setPending(label);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending("");
    }
  };

  const browse = async (marketId: string): Promise<void> => {
    if (browsing === marketId) {
      setBrowsing(null);
      return;
    }
    await run("正在读取市场清单…", async () => {
      const entries = await bridge.listMarketplaceEntries(marketId);
      setMarketPlugins(entries);
      setBrowsing(marketId);
    });
  };

  const installedKeys = new Set(
    (info?.plugins ?? []).map((p) => `${p.name}@${p.marketplace}`),
  );
  const busy = pending !== "";

  return (
    <>
      {pending && <div className="foot-notice page-notice">{pending}</div>}
      {error && <div className="foot-notice page-notice">{error}</div>}
      {!pending && !error && info?.notice && (
        <div className="foot-notice page-notice">{info.notice}</div>
      )}
      <div className="page-actions">
        <button className="btn primary" disabled={busy} onClick={() => setAdding((v) => !v)}>
          {adding ? "收起" : "＋ 添加插件市场"}
        </button>
      </div>
      {adding && (
        <div className="auto-form">
          <div className="auto-grid">
            <label className="auto-field">
              市场来源（本地目录 / owner/repo / git url / marketplace.json url）
              <input
                value={input}
                placeholder="D:/my-market 或 zai-org/wcode-plugins"
                onChange={(e) => setInput(e.target.value)}
              />
            </label>
          </div>
          <div className="auto-form-actions">
            <button
              className="btn primary"
              disabled={busy || !input.trim()}
              onClick={() =>
                void run("正在添加市场（克隆仓库可能需要一些时间）…", async () => {
                  await bridge.pluginAddMarketplace(input.trim());
                  setInput("");
                  setAdding(false);
                })
              }
            >
              添加市场
            </button>
          </div>
        </div>
      )}

      <h2>已安装插件</h2>
      {(info?.plugins.length ?? 0) === 0 ? (
        <div className="empty-hint">
          未安装插件。先添加插件市场，再从市场安装；或用 CLI：/plugin market add … → /plugin install …
        </div>
      ) : (
        info?.plugins.map((p) => (
          <div key={`${p.name}@${p.marketplace}`} className="row-card">
            <div className="row-main">
              <span className="row-title">
                {p.name} <span className="row-sub">v{p.version}</span>
              </span>
              <span className="row-sub">
                {p.description ?? "（无描述）"}
                <br />
                技能 {p.skillCount} · 命令 {p.commandCount} · 子Agent {p.agentCount} · MCP {p.mcpCount}
                {p.format === "claude" ? " · .claude-plugin 兼容" : ""}
              </span>
            </div>
            <span className="chip">
              {p.marketplace === "wcode-builtin" ? "内置" : p.marketplace}
            </span>
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void run("正在切换插件状态…", () =>
                  bridge.pluginSetEnabled(p.marketplace, p.name, !p.enabled),
                )
              }
            >
              {p.enabled ? "停用" : "启用"}
            </button>
            <button
              className="btn danger"
              disabled={busy}
              onClick={() => void run("正在卸载插件…", () => bridge.pluginUninstall(p.marketplace, p.name))}
            >
              卸载
            </button>
          </div>
        ))
      )}

      <h2>插件市场</h2>
      {(info?.marketplaces.length ?? 0) === 0 ? (
        <div className="empty-hint">
          未登记插件市场。添加本地目录（含 marketplace.json）、GitHub 仓库（owner/repo）或市场清单 url。
        </div>
      ) : (
        info?.marketplaces.map((m) => (
          <div key={m.id} className="row-card" style={{ display: "block" }}>
            <div className="row-main" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="row-title">{m.id}</span>
              <span className="chip">{m.pluginCount} 个插件</span>
              <span style={{ flex: 1 }} />
              <button className="btn" disabled={busy} onClick={() => void browse(m.id)}>
                {browsing === m.id ? "收起" : "浏览"}
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  void run("正在刷新市场（重新克隆/拷贝）…", async () => {
                    await bridge.pluginRefreshMarketplace(m.id);
                    const entries = await bridge.listMarketplaceEntries(m.id);
                    setMarketPlugins(entries);
                    setBrowsing(m.id);
                  })
                }
              >
                刷新
              </button>
              <button
                className="btn danger"
                disabled={busy}
                onClick={() => void run("正在移除市场…", () => bridge.pluginRemoveMarketplace(m.id))}
              >
                移除
              </button>
            </div>
            <div className="row-sub">
              {m.source}
              {m.description ? ` — ${m.description}` : ""}
            </div>
            {browsing === m.id && (
              <div style={{ marginTop: 8 }}>
                {marketPlugins.length === 0 ? (
                  <div className="empty-hint">市场清单为空或读取失败（试试「刷新」）。</div>
                ) : (
                  marketPlugins.map((e) => {
                    const installed = installedKeys.has(`${e.name}@${m.id}`);
                    return (
                      <div key={e.name} className="row-card">
                        <div className="row-main">
                          <span className="row-title">
                            {e.name}
                            {e.version ? <span className="row-sub"> v{e.version}</span> : null}
                          </span>
                          <span className="row-sub">{e.description ?? "（无描述）"}</span>
                        </div>
                        {installed ? (
                          <span className="chip ok">已安装</span>
                        ) : (
                          <button
                            className="btn primary"
                            disabled={busy}
                            onClick={() =>
                              void run(`正在安装 ${e.name}（克隆/拷贝可能需要一些时间）…`, () =>
                                bridge.pluginInstall(m.id, e.name),
                              )
                            }
                          >
                            安装
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        ))
      )}
    </>
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
