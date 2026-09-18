import { useEffect, useRef, useState, type ReactNode } from "react";

/** 斜杠命令面板条目：aliases[0] 作为面板里展示的命令 token */
export interface ComposerCommand {
  id: string;
  label: string;
  hint?: string;
  aliases?: string[];
}

export function Composer({
  running,
  onSend,
  onAbort,
  toolbar,
  projectName,
  commands,
  onCommand,
}: {
  running: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
  /** 输入卡底部工具行（模型/思考级别等选择器） */
  toolbar?: ReactNode;
  /** 项目名：显示在输入卡上方 */
  projectName?: string;
  /** 斜杠命令面板（提供后输入 / 唤起） */
  commands?: ComposerCommand[];
  onCommand?: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const [hi, setHi] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  // 面板激活条件：单行文本以 / 开头；/ 后文本作为过滤词（空 = 罗列全部）
  const slashQuery =
    text.startsWith("/") && !text.includes("\n") ? text.slice(1).trim().toLowerCase() : null;
  const matches =
    slashQuery === null || !commands || !onCommand || dismissed
      ? []
      : commands.filter(
          (c) =>
            c.aliases?.some((a) => a.startsWith(slashQuery)) ||
            c.label.toLowerCase().includes(slashQuery),
        );
  const paletteOpen = matches.length > 0;

  useEffect(() => setHi(0), [slashQuery]);
  useEffect(() => setDismissed(false), [text]);

  const pick = (cmd: ComposerCommand) => {
    setText("");
    setDismissed(false);
    onCommand?.(cmd.id);
    ref.current?.focus();
  };

  const submit = () => {
    const t = text.trim();
    if (t === "" || running) return;
    onSend(t);
    setText("");
  };

  return (
    <div className="composer">
      {projectName && <div className="composer-project">{projectName}</div>}
      <div className="composer-box">
        {paletteOpen && (
          <div className="cmd-palette" role="listbox" aria-label="命令列表">
            {matches.map((c, i) => (
              <button
                key={c.id}
                type="button"
                className={i === hi ? "cmd-item on" : "cmd-item"}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(c);
                }}
                onMouseEnter={() => setHi(i)}
              >
                <span className="cmd-token">/{c.aliases?.[0] ?? c.id}</span>
                <span className="cmd-label">{c.label}</span>
                {c.hint && <span className="cmd-hint">{c.hint}</span>}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={
            running ? "运行中…可点击下方停止" : "输入消息，/ 唤起命令，Enter 发送，Shift+Enter 换行"
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (paletteOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHi((i) => Math.min(i + 1, matches.length - 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setHi((i) => Math.max(i - 1, 0));
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissed(true);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pick(matches[hi] ?? matches[0]!);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-foot">
          {toolbar}
          {running ? (
            <button className="send-btn stop" title="停止" onClick={onAbort}>
              ■
            </button>
          ) : (
            <button
              className="send-btn"
              title="发送"
              disabled={text.trim() === ""}
              onClick={submit}
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
