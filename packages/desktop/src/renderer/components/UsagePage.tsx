import type { RuntimeInfo } from "../../shared/protocol";

export function UsagePage({ info }: { info: RuntimeInfo | null }) {
  const current = info?.projects.find((p) => p.current);
  const sessions = (current?.sessions ?? []).filter((s) => s.messageCount > 0).slice(0, 12);
  const max = Math.max(1, ...sessions.map((s) => s.messageCount));
  // 费用估算：激活服务商的单价比价（settings.json priceInput/priceOutput，单位 priceCurrency/百万 tokens）
  const pricing = info?.pricing;
  const cost = pricing
    ? ((info?.stats.inputTokens ?? 0) / 1e6) * pricing.inputPerMillion +
      ((info?.stats.outputTokens ?? 0) / 1e6) * pricing.outputPerMillion
    : null;
  return (
    <div className="page">
      <h1>用量统计</h1>
      <p className="page-sub">当前项目的会话聚合；tokens 来自 core 的用量事件。</p>
      <div className="stat-cards">
        <div className="stat-card">
          <span className="stat-num">{info?.stats.sessionCount ?? 0}</span>
          <span className="stat-label">会话</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{info?.stats.messageCount ?? 0}</span>
          <span className="stat-label">消息</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{info?.stats.inputTokens ?? 0}</span>
          <span className="stat-label">输入 tokens</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{info?.stats.outputTokens ?? 0}</span>
          <span className="stat-label">输出 tokens</span>
        </div>
        {pricing && cost !== null && (
          <div className="stat-card cost">
            <span className="stat-num">
              ≈{cost.toFixed(2)} {pricing.currency}
            </span>
            <span className="stat-label">
              费用估算（输入 {pricing.inputPerMillion} / 输出 {pricing.outputPerMillion}{" "}
              {pricing.currency}/百万 tokens）
            </span>
          </div>
        )}
      </div>
      {!pricing && (
        <div className="empty-hint">
          想看费用估算？在 ~/.wcode/settings.json 的对应 provider 里加 priceInput / priceOutput
          （每百万 tokens 单价，可选 priceCurrency，缺省"元"）。
        </div>
      )}
      <h2>最近会话消息量</h2>
      <div className="bars">
        {sessions.map((s) => (
          <div key={s.id} className="bar-row" title={`${s.title} · ${s.messageCount} 条消息`}>
            <span className="bar-label">{s.title}</span>
            <div className="bar-track">
              <div className="bar" style={{ width: `${(s.messageCount / max) * 100}%` }} />
            </div>
            <span className="bar-num">{s.messageCount}</span>
          </div>
        ))}
        {sessions.length === 0 && <div className="empty-hint">暂无会话数据</div>}
      </div>
    </div>
  );
}
