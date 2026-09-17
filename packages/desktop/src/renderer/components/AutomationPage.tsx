import { useCallback, useEffect, useState } from "react";
import type {
  AutomationEntry,
  AutomationRunEntry,
  AutomationSpecInput,
  RuntimeInfo,
  WcodeBridge,
} from "../../shared/protocol";

const MODE_OPTIONS = [
  { value: "default", label: "请求批准（无人值守时自动拒绝变更）" },
  { value: "acceptEdits", label: "自动批准编辑" },
  { value: "bypass", label: "完全访问（⚠无人值守慎用）" },
];

function fmt(ms: number | null | undefined): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function describeSchedule(a: AutomationEntry): string {
  return a.scheduleKind === "cron" ? `cron「${a.cronExpr ?? ""}」` : `一次性 @ ${fmt(a.runAt)}`;
}

function stateChip(a: AutomationEntry): { text: string; cls: string } {
  if (a.running) return { text: "运行中", cls: "ok" };
  if (!a.enabled) return { text: "已停用", cls: "" };
  if (a.dispatchAttempts > 0) return { text: `退避中（${a.dispatchAttempts} 次失败）`, cls: "warn" };
  return { text: "待调度", cls: "ok" };
}

function fmtDuration(r: AutomationRunEntry): string {
  if (r.finishedAt === null) return "进行中";
  return `${((r.finishedAt - r.startedAt) / 1000).toFixed(1)}s`;
}

export function AutomationPage({ bridge, info }: { bridge: WcodeBridge; info: RuntimeInfo | null }) {
  const [list, setList] = useState<AutomationEntry[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [runsView, setRunsView] = useState<{ id: string; runs: AutomationRunEntry[] } | null>(null);

  const refresh = useCallback(() => {
    bridge
      .listAutomations()
      .then(setList)
      .catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, [bridge]);

  useEffect(() => {
    refresh();
  }, [refresh, info]); // info 每次主进程推送都是新引用：任务跑完 onChanged → 自动刷新列表

  const act = async (id: string, fn: () => Promise<unknown>): Promise<void> => {
    setError("");
    setBusyId(id);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const showRuns = (id: string) => {
    if (runsView?.id === id) {
      setRunsView(null);
      return;
    }
    void bridge
      .listAutomationRuns(id)
      .then((runs) => setRunsView({ id, runs }))
      .catch((e) => setError(String(e instanceof Error ? e.message : e)));
  };

  return (
    <div className="page">
      <h1>定时任务</h1>
      <p className="page-sub">
        cron / 一次性自动化：由应用内置调度器执行（与 wcode daemon 共库互斥，不会双跑）。
        会话在任务目录下真实持久化，可从侧栏打开回看。
      </p>
      <div className="page-actions">
        <button className="btn primary" onClick={() => setCreating((v) => !v)}>
          {creating ? "收起表单" : "＋ 新建自动化"}
        </button>
      </div>
      {error && <div className="foot-notice page-notice">{error}</div>}

      {creating && (
        <AutomationForm
          bridge={bridge}
          defaultCwd={info?.currentCwd ?? ""}
          onDone={() => {
            setCreating(false);
            refresh();
          }}
        />
      )}

      {list !== null && list.length === 0 && !creating && (
        <div className="empty-hint">还没有自动化任务——点「新建自动化」创建第一个。</div>
      )}
      {list?.map((a) => {
        const chip = stateChip(a);
        const busy = busyId === a.id;
        return (
          <div key={a.id} className="auto-card">
            <div className="row-main">
              <span className="row-title">
                {a.mode === "bypass" && <span className="warn-mark">⚠ </span>}
                {a.title}
              </span>
              <span className="row-sub">{a.prompt}</span>
              <span className="row-sub mono">
                {describeSchedule(a)} · 目录 {a.cwd} · 已运行 {a.runCount}
                {a.maxRuns ? `/${a.maxRuns}` : ""} 次
              </span>
              <span className="row-sub">
                上次 {fmt(a.lastRunAt)} · 下次 {a.enabled ? fmt(a.nextRunAt) : "—"}
                {a.lastError ? ` · 最近错误: ${a.lastError.slice(0, 80)}` : ""}
              </span>
            </div>
            <span className={`chip ${chip.cls}`}>{chip.text}</span>
            <button className="btn" disabled={busy} onClick={() => void act(a.id, () => bridge.runAutomation(a.id))}>
              运行
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() => void act(a.id, () => bridge.setAutomationEnabled(a.id, !a.enabled))}
            >
              {a.enabled ? "停用" : "启用"}
            </button>
            <button className="btn" onClick={() => showRuns(a.id)}>
              记录
            </button>
            <button
              className="btn danger"
              disabled={busy}
              onClick={() => void act(a.id, () => bridge.removeAutomation(a.id))}
            >
              删除
            </button>
            {runsView?.id === a.id && (
              <div className="auto-runs">
                {runsView.runs.length === 0 ? (
                  <div className="row-sub">还没有运行记录。</div>
                ) : (
                  runsView.runs.map((r) => (
                    <div key={r.id} className="auto-run-row">
                      <span className="row-sub mono">
                        {fmt(r.startedAt)} · {r.trigger === "manual" ? "手动" : "调度"} ·{" "}
                        {r.outcome ?? "运行中"} · {fmtDuration(r)}
                        {r.error ? ` · ${r.error.slice(0, 60)}` : ""}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AutomationForm({
  bridge,
  defaultCwd,
  onDone,
}: {
  bridge: WcodeBridge;
  defaultCwd: string;
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<"cron" | "once">("cron");
  const [cronExpr, setCronExpr] = useState("0 9 * * 1-5");
  const [onceAt, setOnceAt] = useState("");
  const [mode, setMode] = useState("default");
  const [cwd, setCwd] = useState(defaultCwd);
  const [timeoutMin, setTimeoutMin] = useState("");
  const [maxRuns, setMaxRuns] = useState("");
  const [error, setError] = useState("");

  const submit = async (): Promise<void> => {
    setError("");
    try {
      const runAt = kind === "once" ? new Date(onceAt).getTime() : undefined;
      if (kind === "once" && (runAt === undefined || runAt <= Date.now())) {
        setError("一次性任务需要未来的时间");
        return;
      }
      const spec: AutomationSpecInput = {
        title: title.trim() || prompt.slice(0, 30),
        prompt,
        cwd,
        mode,
        schedule:
          kind === "cron"
            ? { kind: "cron", expr: cronExpr.trim() }
            : { kind: "once", runAt: runAt ?? 0 },
        ...(timeoutMin ? { timeoutMs: Number(timeoutMin) * 60_000 } : {}),
        ...(maxRuns ? { maxRuns: Number(maxRuns) } : {}),
      };
      await bridge.addAutomation(spec);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="auto-form">
      <label className="auto-field">
        任务提示词（模型收到的完整指令）
        <textarea
          value={prompt}
          placeholder='例：检查未读 Issue，汇总成 markdown 追加到 notes.md'
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      <div className="auto-grid">
        <label className="auto-field">
          任务名称（可留空）
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="默认取提示词前 30 字" />
        </label>
        <label className="auto-field">
          执行目录
          <div className="auto-inline">
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} />
            <button
              className="btn"
              onClick={() =>
                void bridge.pickFolder().then((dir) => {
                  if (dir) setCwd(dir);
                })
              }
            >
              选择
            </button>
          </div>
        </label>
        <label className="auto-field">
          调度
          <div className="auto-inline">
            <select className="sel" value={kind} onChange={(e) => setKind(e.target.value as "cron" | "once")}>
              <option value="cron">循环（cron）</option>
              <option value="once">一次性</option>
            </select>
            {kind === "cron" ? (
              <input
                className="mono"
                value={cronExpr}
                placeholder="0 9 * * 1-5"
                onChange={(e) => setCronExpr(e.target.value)}
              />
            ) : (
              <input type="datetime-local" value={onceAt} onChange={(e) => setOnceAt(e.target.value)} />
            )}
          </div>
        </label>
        <label className="auto-field">
          权限模式
          <select className="sel" value={mode} onChange={(e) => setMode(e.target.value)}>
            {MODE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="auto-field">
          单次超时（分钟，可空）
          <input
            type="number"
            min="1"
            value={timeoutMin}
            placeholder="不限"
            onChange={(e) => setTimeoutMin(e.target.value)}
          />
        </label>
        <label className="auto-field">
          最多运行次数（可空）
          <input
            type="number"
            min="1"
            value={maxRuns}
            placeholder="不限"
            onChange={(e) => setMaxRuns(e.target.value)}
          />
        </label>
      </div>
      {error && <div className="foot-notice">{error}</div>}
      <div className="auto-form-actions">
        <button className="btn primary" onClick={() => void submit()}>
          创建
        </button>
      </div>
    </div>
  );
}
