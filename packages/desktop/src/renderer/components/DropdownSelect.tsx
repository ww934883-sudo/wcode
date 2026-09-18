import { useEffect, useRef, useState } from "react";

export interface DropdownOption {
  value: string;
  label: string;
}

/**
 * 通用下拉选择（与模型选择器同视觉语言）：单行按钮 + 向上弹出的选项列表。
 * 选项弹层复用 .model-dd / .model-dd-item 样式。
 * disabled 时按钮不可点且降低透明度，弹层不展开。
 */
export function DropdownSelect({
  value,
  options,
  onSelect,
  title,
  disabled,
}: {
  value: string;
  options: DropdownOption[];
  onSelect: (value: string) => void;
  title?: string;
  disabled?: boolean;
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

  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <div className="dd-select" ref={ref}>
      <button
        type="button"
        className="sel dd-select-btn"
        style={disabled ? { opacity: 0.45 } : undefined}
        disabled={disabled}
        title={title ?? current?.label}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="dd-select-label">{current?.label}</span>
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
        <div className="model-dd" role="listbox" aria-label={title ?? "选项列表"}>
          {options.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={active}
                className={"model-dd-item" + (active ? " on" : "")}
                title={o.label}
                onClick={() => {
                  setOpen(false);
                  if (!active) onSelect(o.value);
                }}
              >
                <span className="dd-option-label">{o.label}</span>
                {active && <span className="model-dd-check">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
