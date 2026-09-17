import { useState } from "react";
import type { RuntimeInfo } from "../../shared/protocol";

export function SettingsPage({
  info,
  onSaveKey,
  onSetActive,
}: {
  info: RuntimeInfo | null;
  onSaveKey: (name: string, key: string) => void;
  onSetActive: (name: string) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  return (
    <div className="page">
      <h1>设置</h1>
      <p className="page-sub">
        API 密钥只写入用户级 ~/.wcode/settings.json（仓库外；渲染层不接触明文，保存动作经主进程落盘）。
        当前模式：{info?.mode === "demo" ? "演示（配置 key 后重启应用进入真实模型）" : "真实模型"}。
      </p>
      {(info?.providers.length ?? 0) === 0 && (
        <div className="empty-hint">
          未配置任何服务商——在 ~/.wcode/settings.json 里添加 providers 后重启，或直接在此录入。
        </div>
      )}
      {info?.providers.map((p) => (
        <div key={p.name} className="row-card">
          <label className="row-main">
            <input
              type="radio"
              name="active-provider"
              checked={p.active}
              onChange={() => onSetActive(p.name)}
              title="设为默认服务商"
            />
            <span className="row-title">{p.name}</span>
            <span className="chip">{p.type}</span>
            <span className={`chip ${p.hasKey ? "ok" : "warn"}`}>
              {p.hasKey ? "已配置 key" : "缺 key"}
            </span>
          </label>
          <div className="row-actions">
            <input
              type="password"
              className="key-input"
              placeholder={p.hasKey ? "已配置（输入可覆盖）" : "sk-…"}
              value={draft[p.name] ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, [p.name]: e.target.value }))}
            />
            <button
              className="btn primary"
              disabled={(draft[p.name] ?? "") === ""}
              onClick={() => {
                onSaveKey(p.name, draft[p.name] ?? "");
                setDraft((d) => ({ ...d, [p.name]: "" }));
              }}
            >
              保存
            </button>
          </div>
        </div>
      ))}
      {info?.notice && <div className="foot-notice page-notice">{info.notice}</div>}
    </div>
  );
}
