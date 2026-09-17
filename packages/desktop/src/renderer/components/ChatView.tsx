import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useRef } from "react";
import type { PermissionDecision } from "@wcode/core";
import { summarizeInput, type ChatItem, type UiState } from "../state";

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}

const SUGGESTIONS = ["这个项目是做什么的？", "帮我读一下 README", "演示权限确认流程"];

export function ChatView({
  ui,
  onDecide,
  onSuggest,
  onFork,
}: {
  ui: UiState;
  onDecide: (id: string, decision: PermissionDecision) => void;
  onSuggest: (text: string) => void;
  onFork: (userTurn: number) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [ui.items]);

  if (ui.items.length === 0) {
    return (
      <div className="chat">
        <div className="empty">
          <div className="empty-logo">w</div>
          <h1>开始一段对话</h1>
          <p>演示模式下模型输出为本地脚本，工具与权限确认真实执行。</p>
          <div className="suggest">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="suggest-chip" onClick={() => onSuggest(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
        <div ref={bottomRef} />
      </div>
    );
  }

  let userTurn = -1;
  return (
    <div className="chat">
      <div className="thread">
        {ui.items.map((item) => {
          if (item.kind === "user") userTurn++;
          switch (item.kind) {
            case "user":
              return (
                <div key={item.id} className="msg user">
                  <button
                    className="fork-btn"
                    title="从这里之前的历史分叉一个新会话"
                    onClick={() => onFork(userTurn)}
                  >
                    ⟲
                  </button>
                  <div className="bubble">{item.text}</div>
                </div>
              );
            case "assistant":
              return (
                <div key={item.id} className="msg assistant">
                  <div className="avatar">w</div>
                  <div className="bubble md">
                    <span dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />
                    {item.streaming && <span className="cursor" />}
                  </div>
                </div>
              );
            case "tool":
              return <ToolCard key={item.id} item={item} />;
            case "permission":
              return <PermCard key={item.id} item={item} onDecide={onDecide} />;
            case "notice":
              return (
                <div key={item.id} className={`notice ${item.level}`}>
                  {item.text}
                </div>
              );
          }
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function ToolCard({ item }: { item: ChatItem & { kind: "tool" } }) {
  return (
    <div className="msg tool-row">
      <div className={`tool-card ${item.status}`}>
        <span className="tool-icon">
          {item.status === "running" ? (
            <span className="spin" />
          ) : item.status === "ok" ? (
            "✓"
          ) : (
            "✗"
          )}
        </span>
        <span className="tool-name">{item.name}</span>
        <span className="tool-args">{summarizeInput(item.input)}</span>
        {item.durationMs !== undefined && (
          <span className="tool-dur">{item.durationMs}ms</span>
        )}
        {item.summary && <div className="tool-summary">{item.summary}</div>}
        <details className="tool-input">
          <summary>参数</summary>
          <pre>{JSON.stringify(item.input, null, 2)}</pre>
        </details>
      </div>
    </div>
  );
}

function PermCard({
  item,
  onDecide,
}: {
  item: ChatItem & { kind: "permission" };
  onDecide: (id: string, decision: PermissionDecision) => void;
}) {
  if (item.decided) {
    const text =
      item.decided === "deny"
        ? `已拒绝 ${item.toolName}`
        : item.decided === "allowAlways"
          ? `已总是允许 ${item.toolName}`
          : `已允许 ${item.toolName}`;
    return <div className="perm-done">{text}</div>;
  }
  return (
    <div className="perm-card">
      <div className="perm-head">权限确认 · {item.toolName}</div>
      <pre className="perm-input">{JSON.stringify(item.input, null, 2)}</pre>
      <div className="perm-actions">
        <button className="btn primary" onClick={() => onDecide(item.id, "allow")}>
          允许一次
        </button>
        <button className="btn" onClick={() => onDecide(item.id, "allowAlways")}>
          总是允许
        </button>
        <button className="btn danger" onClick={() => onDecide(item.id, "deny")}>
          拒绝
        </button>
      </div>
    </div>
  );
}
