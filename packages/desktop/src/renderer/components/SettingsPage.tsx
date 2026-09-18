import { useState } from "react";
import type { ModelCatalogGroup, RuntimeInfo } from "../../shared/protocol";

export function SettingsPage({
  info,
  catalog,
  onSaveKey,
  onSetActive,
  onAddModel,
  onRemoveModel,
}: {
  info: RuntimeInfo | null;
  catalog: ModelCatalogGroup[];
  onSaveKey: (name: string, key: string) => void;
  onSetActive: (name: string) => void;
  onAddModel: (provider: string, model: string) => void;
  onRemoveModel: (provider: string, model: string) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [modelDraft, setModelDraft] = useState<Record<string, string>>({});
  return (
    <div className="page">
      <h1>设置</h1>
      <p className="page-sub">
        API 密钥只写入用户级 ~/.wcode/settings.json（仓库外；渲染层不接触明文，保存动作经主进程落盘）。
        配置的模型存入 SQLite（~/.wcode/wcode.db provider_models 表），输入框的模型列表按供应商分组展示。
        当前模式：{info?.mode === "demo" ? "演示（配置 key 后重启应用进入真实模型）" : "真实模型"}。
      </p>
      {(info?.providers.length ?? 0) === 0 && (
        <div className="empty-hint">
          未配置任何服务商——在 ~/.wcode/settings.json 里添加 providers 后重启，或直接在此录入。
        </div>
      )}
      {info?.providers.map((p) => {
        const models = catalog.find((g) => g.provider === p.name)?.models ?? [];
        return (
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
            <div className="row-models">
              <span className="row-sub">配置模型（{models.length}）</span>
              <div className="model-chips">
                {models.map((m) => (
                  <span key={m} className={"model-chip" + (p.active && m === info?.model ? " on" : "")}>
                    <span className="mono">{m}</span>
                    <button
                      className="model-chip-del"
                      title={`删除 ${m}`}
                      aria-label={`删除模型 ${m}`}
                      onClick={() => onRemoveModel(p.name, m)}
                    >
                      ×
                    </button>
                  </span>
                ))}
                {models.length === 0 && <span className="row-sub">暂无——添加模型 id 后会出现在输入框的模型列表里</span>}
              </div>
              <div className="model-add">
                <input
                  className="key-input"
                  placeholder="模型 id（如 glm-5.3-flash）"
                  value={modelDraft[p.name] ?? ""}
                  onChange={(e) => setModelDraft((d) => ({ ...d, [p.name]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (modelDraft[p.name] ?? "").trim() !== "") {
                      onAddModel(p.name, (modelDraft[p.name] ?? "").trim());
                      setModelDraft((d) => ({ ...d, [p.name]: "" }));
                    }
                  }}
                />
                <button
                  className="btn"
                  disabled={(modelDraft[p.name] ?? "").trim() === ""}
                  onClick={() => {
                    onAddModel(p.name, (modelDraft[p.name] ?? "").trim());
                    setModelDraft((d) => ({ ...d, [p.name]: "" }));
                  }}
                >
                  添加
                </button>
              </div>
            </div>
          </div>
        );
      })}
      {info?.notice && <div className="foot-notice page-notice">{info.notice}</div>}
    </div>
  );
}
