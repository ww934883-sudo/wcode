import { useEffect, useState } from "react";
import type { ModelCatalogGroup, RuntimeInfo } from "../../shared/protocol";

const TYPE_OPTIONS = [
  { value: "anthropic", label: "Anthropic Messages (/v1/messages)" },
  { value: "openai-compatible", label: "OpenAI Chat Completions (/v1/chat/completions)" },
  { value: "openai-responses", label: "OpenAI Responses (/v1/responses)" },
];

const API_FORMATS: Record<string, string> = {
  anthropic: "Anthropic Messages (/v1/messages)",
  "openai-compatible": "OpenAI Chat Completions (/v1/chat/completions)",
  "openai-responses": "OpenAI Responses (/v1/responses)",
};

interface TestState {
  status: "running" | "ok" | "fail";
  latencyMs?: number;
  error?: string;
}

export function SettingsPage({
  info,
  catalog,
  onAddProvider,
  onRemoveProvider,
  onUpdateProvider,
  onRenameProvider,
  onSetEnabled,
  onSetActive,
  onSaveKey,
  onGetKey,
  onTestModel,
  onAddModel,
  onRemoveModel,
  onUpdateModel,
}: {
  info: RuntimeInfo | null;
  catalog: ModelCatalogGroup[];
  onAddProvider: (name: string, opts: { type: string; baseUrl: string }) => Promise<void>;
  onRemoveProvider: (name: string) => void;
  onUpdateProvider: (name: string, patch: { baseUrl?: string; type?: string }) => void;
  onRenameProvider: (oldName: string, newName: string) => void;
  onSetEnabled: (name: string, enabled: boolean) => void;
  onSetActive: (name: string) => void;
  onSaveKey: (name: string, key: string) => Promise<void>;
  onGetKey: (name: string) => Promise<string>;
  onTestModel: (provider: string, model: string) => Promise<{ ok: boolean; latencyMs: number; sample?: string; error?: string }>;
  onAddModel: (provider: string, model: string, contextLabel?: string) => Promise<void>;
  onRemoveModel: (provider: string, model: string) => void;
  onUpdateModel: (provider: string, model: string, patch: { model?: string; contextLabel?: string | null }) => void;
}) {
  const providers = info?.providers ?? [];
  const [selectedName, setSelectedName] = useState<string | null>(null);
  // 选中编辑的供应商：默认跟随当前使用中的；被删除后回落
  const selected = providers.some((p) => p.name === selectedName)
    ? selectedName
    : (providers.find((p) => p.active) ?? providers[0])?.name ?? null;
  const cur = providers.find((p) => p.name === selected) ?? null;

  const [err, setErr] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [addDraft, setAddDraft] = useState({ name: "", type: "openai-compatible", baseUrl: "" });
  const [addKey, setAddKey] = useState("");
  const [addModels, setAddModels] = useState<{ model: string; contextLabel: string }[]>([]);
  const [addModelDraft, setAddModelDraft] = useState({ model: "", contextLabel: "" });
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [urlDraft, setUrlDraft] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [keyOriginal, setKeyOriginal] = useState("");
  const [keyVisible, setKeyVisible] = useState(false);
  const [testState, setTestState] = useState<Record<string, TestState>>({});
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ model: "", contextLabel: "" });
  const [newModel, setNewModel] = useState({ model: "", contextLabel: "" });

  // 切换供应商时同步草稿；已配置的 key 以密文（password 框）回填，点眼睛看明文
  useEffect(() => {
    setUrlDraft(cur?.baseUrl ?? "");
    setRenaming(false);
    setEditingModel(null);
    if (!cur?.name) return;
    let alive = true;
    void onGetKey(cur.name)
      .then((k) => {
        if (!alive) return;
        setKeyDraft(k);
        setKeyOriginal(k);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [cur?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown> | unknown): Promise<boolean> => {
    setErr("");
    try {
      await fn();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const entries = catalog.find((g) => g.provider === cur?.name)?.models ?? [];

  const runTest = async (model: string) => {
    if (!cur) return;
    setTestState((s) => ({ ...s, [model]: { status: "running" } }));
    const r = await onTestModel(cur.name, model);
    setTestState((s) => ({
      ...s,
      [model]: r.ok
        ? { status: "ok", latencyMs: r.latencyMs }
        : { status: "fail", error: r.error },
    }));
  };

  return (
    <div className="page">
      <div className="settings-shell">
        {/* ── 左：供应商导航 ── */}
        <aside className="settings-nav">
          <div className="settings-nav-title">供应商</div>
          <div className="settings-nav-list">
            {providers.map((p) => (
              <button
                key={p.name}
                className={"settings-nav-item" + (p.name === selected ? " on" : "")}
                onClick={() => setSelectedName(p.name)}
                title={p.name}
              >
                <span className={"status-dot" + (p.enabled ? " ok" : "")} />
                <span className="settings-nav-name">{p.name}</span>
                {p.active && <span className="chip ok">使用中</span>}
              </button>
            ))}
          </div>
          {showAdd ? (
            <button className="settings-add-btn" onClick={() => setShowAdd(false)}>
              收起表单
            </button>
          ) : (
            <button className="settings-add-btn" onClick={() => setShowAdd(true)}>
              ＋ 添加供应商
            </button>
          )}
        </aside>

        {/* ── 右：选中供应商的详情配置；点击「添加供应商」时显示创建表单 ── */}
        <section className="settings-detail">
          {showAdd ? (
            <div className="settings-create">
              <h2 className="settings-name">添加供应商</h2>
              <div className="settings-fields">
                <label className="field">
                  <span>名称</span>
                  <div className="field-row">
                    <input
                      autoFocus
                      placeholder="如 Kimi / Z.ai / 火山"
                      value={addDraft.name}
                      onChange={(e) => setAddDraft((d) => ({ ...d, name: e.target.value }))}
                    />
                  </div>
                </label>
                <label className="field">
                  <span>API 格式</span>
                  <div className="field-row">
                    <select
                      value={addDraft.type}
                      onChange={(e) => setAddDraft((d) => ({ ...d, type: e.target.value }))}
                    >
                      {TYPE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </label>
                <label className="field">
                  <span>Base URL（可留空，用该协议的默认地址）</span>
                  <div className="field-row">
                    <input
                      placeholder="https://api.kimi.com/coding"
                      value={addDraft.baseUrl}
                      onChange={(e) => setAddDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                    />
                  </div>
                </label>
                <label className="field">
                  <span>API Key（可留空，之后在详情里录入）</span>
                  <div className="field-row">
                    <input
                      type={keyVisible ? "text" : "password"}
                      placeholder="sk-…"
                      value={addKey}
                      onChange={(e) => setAddKey(e.target.value)}
                    />
                    <button
                      className="icon-btn"
                      title={keyVisible ? "隐藏" : "显示"}
                      onClick={() => setKeyVisible((v) => !v)}
                    >
                      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        {keyVisible ? (
                          <>
                            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
                            <circle cx="12" cy="12" r="3" />
                          </>
                        ) : (
                          <>
                            <path d="M2 12s3.5-7 10-7c2 0 3.7.6 5.2 1.5M22 12s-3.5 7-10 7c-2 0-3.7-.6-5.2-1.5" />
                            <path d="M4 20L20 4" />
                          </>
                        )}
                      </svg>
                    </button>
                  </div>
                </label>
              </div>
              <div className="settings-models">
                <div className="settings-models-title">模型列表（{addModels.length}）</div>
                {addModels.map((m, idx) => (
                  <div key={`${m.model}-${idx}`} className="model-row">
                    <span className="mono">{m.model}</span>
                    {m.contextLabel && <span className="ctx-chip">{m.contextLabel}</span>}
                    <span className="model-row-actions" style={{ display: "flex" }}>
                      <button
                        className="icon-btn danger"
                        title="移除"
                        onClick={() => setAddModels((list) => list.filter((_, i) => i !== idx))}
                      >
                        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                          <path
                            d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.3"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    </span>
                  </div>
                ))}
                <div className="model-add-row">
                  <input
                    placeholder="模型 id（如 kimi-for-coding）"
                    value={addModelDraft.model}
                    onChange={(e) => setAddModelDraft((d) => ({ ...d, model: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && addModelDraft.model.trim() !== "") {
                        setAddModels((l) => [...l, { model: addModelDraft.model.trim(), contextLabel: addModelDraft.contextLabel.trim() }]);
                        setAddModelDraft({ model: "", contextLabel: "" });
                      }
                    }}
                  />
                  <input
                    className="ctx-input"
                    placeholder="上下文（可空，如 1M）"
                    value={addModelDraft.contextLabel}
                    onChange={(e) => setAddModelDraft((d) => ({ ...d, contextLabel: e.target.value }))}
                  />
                  <button
                    className="btn"
                    disabled={addModelDraft.model.trim() === ""}
                    onClick={() => {
                      setAddModels((l) => [...l, { model: addModelDraft.model.trim(), contextLabel: addModelDraft.contextLabel.trim() }]);
                      setAddModelDraft({ model: "", contextLabel: "" });
                    }}
                  >
                    ＋ 添加
                  </button>
                </div>
              </div>
              <div className="settings-create-actions">
                <button
                  className="btn primary"
                  disabled={addDraft.name.trim() === ""}
                  onClick={() =>
                    void run(async () => {
                      const name = addDraft.name.trim();
                      // 依次落盘：供应商 → key → 模型目录（一步失败则停止并提示）
                      await onAddProvider(name, { type: addDraft.type, baseUrl: addDraft.baseUrl });
                      if (addKey.trim() !== "") await onSaveKey(name, addKey.trim());
                      for (const m of addModels) {
                        await onAddModel(name, m.model.trim(), m.contextLabel.trim() || undefined);
                      }
                      setSelectedName(name);
                      setShowAdd(false);
                      setAddDraft({ name: "", type: "openai-compatible", baseUrl: "" });
                      setAddKey("");
                      setAddModels([]);
                      setAddModelDraft({ model: "", contextLabel: "" });
                    })
                  }
                >
                  创建
                </button>
                <button className="btn" onClick={() => setShowAdd(false)}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            cur ? (
            <>
              <div className="settings-detail-head">
                {renaming ? (
                  <span className="rename-row">
                    <input
                      value={renameDraft}
                      autoFocus
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          void run(async () => {
                            await onRenameProvider(cur.name, renameDraft.trim());
                            setSelectedName(renameDraft.trim());
                            setRenaming(false);
                          });
                        }
                      }}
                    />
                    <button
                      className="btn primary"
                      onClick={() =>
                        void run(async () => {
                          await onRenameProvider(cur.name, renameDraft.trim());
                          setSelectedName(renameDraft.trim());
                          setRenaming(false);
                        })
                      }
                    >
                      保存
                    </button>
                    <button className="btn" onClick={() => setRenaming(false)}>
                      取消
                    </button>
                  </span>
                ) : (
                  <h2 className="settings-name">
                    {cur.name}
                    <button
                      className="icon-btn"
                      title="重命名"
                      onClick={() => {
                        setRenameDraft(cur.name);
                        setRenaming(true);
                      }}
                    >
                      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                        <path
                          d="M11.3 2.2l2.5 2.5L6 12.5l-3.2.7.7-3.2zM10 3.5l2.5 2.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.3"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>
                  </h2>
                )}
                <div className="settings-head-actions">
                  <span className={"chip " + (cur.enabled ? "ok" : "")}>
                    {cur.enabled ? "已启用" : "已禁用"}
                  </span>
                  <button
                    className="btn"
                    disabled={cur.active && cur.enabled}
                    title={cur.active && cur.enabled ? "当前使用中的供应商不能禁用" : ""}
                    onClick={() => void run(() => onSetEnabled(cur.name, !cur.enabled))}
                  >
                    {cur.enabled ? "禁用" : "启用"}
                  </button>
                  {!cur.active && (
                    <button className="btn primary" onClick={() => void run(() => onSetActive(cur.name))}>
                      设为当前使用
                    </button>
                  )}
                  <button
                    className="icon-btn danger"
                    title="删除供应商"
                    onClick={() => {
                      if (!window.confirm(`删除供应商「${cur.name}」？其配置模型列表将一并清除。`)) return;
                      void run(async () => {
                        await onRemoveProvider(cur.name);
                        setSelectedName(null);
                      });
                    }}
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                      <path
                        d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="settings-fields">
                <label className="field">
                  <span>Base URL</span>
                  <div className="field-row">
                    <input
                      value={urlDraft}
                      placeholder="https://api.kimi.com/coding"
                      onChange={(e) => setUrlDraft(e.target.value)}
                    />
                    <button
                      className="btn"
                      disabled={urlDraft === (cur.baseUrl ?? "")}
                      onClick={() => void run(() => onUpdateProvider(cur.name, { baseUrl: urlDraft }))}
                    >
                      保存
                    </button>
                  </div>
                </label>
                <label className="field">
                  <span>API 格式</span>
                  <div className="field-row">
                    <select
                      value={cur.type}
                      onChange={(e) => void run(() => onUpdateProvider(cur.name, { type: e.target.value }))}
                    >
                      {TYPE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </label>
                <label className="field">
                  <span>API Key</span>
                  <div className="field-row">
                    <input
                      type={keyVisible ? "text" : "password"}
                      placeholder={cur.hasKey ? "" : "sk-…"}
                      value={keyDraft}
                      onChange={(e) => setKeyDraft(e.target.value)}
                    />
                    <button
                      className="icon-btn"
                      title={keyVisible ? "隐藏" : "显示"}
                      disabled={!cur.hasKey && keyDraft === ""}
                      onClick={() => setKeyVisible((v) => !v)}
                    >
                      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        {keyVisible ? (
                          <>
                            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
                            <circle cx="12" cy="12" r="3" />
                          </>
                        ) : (
                          <>
                            <path d="M2 12s3.5-7 10-7c2 0 3.7.6 5.2 1.5M22 12s-3.5 7-10 7c-2 0-3.7-.6-5.2-1.5" />
                            <path d="M4 20L20 4" />
                          </>
                        )}
                      </svg>
                    </button>
                    <button
                      className="btn primary"
                      disabled={keyDraft === "" || keyDraft === keyOriginal}
                      onClick={() =>
                        void run(async () => {
                          await onSaveKey(cur.name, keyDraft);
                          setKeyOriginal(keyDraft);
                        })
                      }
                    >
                      保存
                    </button>
                  </div>
                </label>
              </div>

              <div className="settings-models">
                <div className="settings-models-title">
                  模型列表（{entries.length}）
                  {cur.hasKey ? "" : " — 缺 API key，测试前请先录入"}
                </div>
                {entries.map((e) => {
                  const t = testState[e.model];
                  return (
                    <div key={e.model} className="model-row">
                      {editingModel === e.model ? (
                        <span className="model-edit">
                          <input
                            value={editDraft.model}
                            autoFocus
                            placeholder="模型 id"
                            onChange={(ev) => setEditDraft((d) => ({ ...d, model: ev.target.value }))}
                          />
                          <input
                            className="ctx-input"
                            value={editDraft.contextLabel}
                            placeholder="上下文（如 1M）"
                            onChange={(ev) => setEditDraft((d) => ({ ...d, contextLabel: ev.target.value }))}
                          />
                          <button
                            className="btn primary"
                            onClick={() =>
                              void run(async () => {
                                await onUpdateModel(cur.name, e.model, {
                                  model: editDraft.model.trim() || e.model,
                                  contextLabel: editDraft.contextLabel.trim() || null,
                                });
                                setEditingModel(null);
                              })
                            }
                          >
                            保存
                          </button>
                          <button className="btn" onClick={() => setEditingModel(null)}>
                            取消
                          </button>
                        </span>
                      ) : (
                        <>
                          <span className="mono">{e.model}</span>
                          {e.contextLabel && <span className="ctx-chip">{e.contextLabel}</span>}
                          <span className="model-row-actions">
                            <button
                              className="icon-btn"
                              title="测试连通性"
                              disabled={t?.status === "running"}
                              onClick={() => void runTest(e.model)}
                            >
                              {t?.status === "running" ? (
                                <span className="spin">◠</span>
                              ) : (
                                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                                  <path
                                    d="M13 2L4.5 13.5H11L9.5 22 19 9.5h-6.5z"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.6"
                                    strokeLinejoin="round"
                                  />
                                </svg>
                              )}
                            </button>
                            <button
                              className="icon-btn"
                              title="编辑模型"
                              onClick={() => {
                                setEditDraft({ model: e.model, contextLabel: e.contextLabel ?? "" });
                                setEditingModel(e.model);
                              }}
                            >
                              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                                <path
                                  d="M11.3 2.2l2.5 2.5L6 12.5l-3.2.7.7-3.2zM10 3.5l2.5 2.5"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.3"
                                  strokeLinecap="round"
                                />
                              </svg>
                            </button>
                            <button
                              className="icon-btn danger"
                              title="删除模型"
                              onClick={() => void run(() => onRemoveModel(cur.name, e.model))}
                            >
                              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                                <path
                                  d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.3"
                                  strokeLinecap="round"
                                />
                              </svg>
                            </button>
                          </span>
                        </>
                      )}
                      {t?.status === "ok" && <span className="test-result ok">✓ {t.latencyMs}ms</span>}
                      {t?.status === "fail" && <span className="test-result fail">{t.error}</span>}
                    </div>
                  );
                })}
                <div className="model-add-row">
                  <input
                    placeholder="模型 id（如 kimi-for-coding）"
                    value={newModel.model}
                    onChange={(e) => setNewModel((d) => ({ ...d, model: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newModel.model.trim() !== "" && cur) {
                        onAddModel(cur.name, newModel.model.trim(), newModel.contextLabel.trim() || undefined);
                        setNewModel({ model: "", contextLabel: "" });
                      }
                    }}
                  />
                  <input
                    className="ctx-input"
                    placeholder="上下文（可空，如 1M）"
                    value={newModel.contextLabel}
                    onChange={(e) => setNewModel((d) => ({ ...d, contextLabel: e.target.value }))}
                  />
                  <button
                    className="btn"
                    disabled={newModel.model.trim() === ""}
                    onClick={() => {
                      if (!cur) return;
                      onAddModel(cur.name, newModel.model.trim(), newModel.contextLabel.trim() || undefined);
                      setNewModel({ model: "", contextLabel: "" });
                    }}
                  >
                    ＋ 添加模型
                  </button>
                </div>
              </div>
            </>
            ) : (
              <div className="empty-hint">还没有供应商——点左侧「＋ 添加供应商」创建。</div>
            )
          )}
          {err && <div className="foot-notice page-notice">{err}</div>}
          {info?.notice && !err && <div className="foot-notice page-notice">{info.notice}</div>}
        </section>
      </div>
    </div>
  );
}
