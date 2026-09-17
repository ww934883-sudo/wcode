import { useEffect, useRef, useState, type ReactNode } from "react";

export function Composer({
  running,
  onSend,
  onAbort,
  toolbar,
  projectName,
}: {
  running: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
  /** 输入卡底部工具行（模型/思考级别等选择器） */
  toolbar?: ReactNode;
  /** 项目名：显示在输入卡上方 */
  projectName?: string;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

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
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={running ? "运行中…可点击下方停止" : "输入消息，Enter 发送，Shift+Enter 换行"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
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
