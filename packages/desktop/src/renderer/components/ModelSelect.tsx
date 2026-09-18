import { useEffect, useRef, useState } from "react";
import type { ModelCatalogGroup } from "../../shared/protocol";

/**
 * 模型选择器（按供应商分组）：按钮显示当前供应商/模型，
 * 下拉按供应商分组列出配置的模型，选中即同时切换供应商与模型。
 */
export function ModelSelect({
  catalog,
  provider,
  model,
  onSelect,
}: {
  catalog: ModelCatalogGroup[];
  provider: string;
  model: string;
  onSelect: (provider: string, model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // 兜底：当前模型不在目录（如刚改配置未入库）时补进当前供应商组，保证选中态可见
  const groups: ModelCatalogGroup[] = (() => {
    const cur = catalog.find((g) => g.provider === provider);
    if (cur?.models.includes(model)) return catalog;
    if (cur) {
      return catalog.map((g) =>
        g === cur ? { ...g, models: [model, ...g.models] } : g,
      );
    }
    return [...catalog, { provider, models: [model] }];
  })();

  return (
    <div className="model-select" ref={ref}>
      <button
        type="button"
        className="sel model-select-btn"
        title="模型（按供应商分组，点击选择）"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="model-select-provider">{provider}</span>
        <span className="model-select-model">{model}</span>
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <path
            d="M6 9l6 6 6-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {open && (
        <div className="model-dd" role="listbox" aria-label="模型列表">
          {groups.map((g) => (
            <div key={g.provider} className="model-dd-group">
              <div className="model-dd-head">
                <span className="model-dd-provider">{g.provider}</span>
                {g.provider === provider && <span className="chip ok">当前</span>}
              </div>
              {g.models.map((m) => {
                const active = g.provider === provider && m === model;
                return (
                  <button
                    key={m}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={"model-dd-item" + (active ? " on" : "")}
                    onClick={() => {
                      setOpen(false);
                      if (!active) onSelect(g.provider, m);
                    }}
                  >
                    <span className="mono">{m}</span>
                    {active && <span className="model-dd-check">✓</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
