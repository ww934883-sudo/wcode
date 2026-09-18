import { useEffect, useRef, useState, type ReactNode } from "react";

/** 斜杠命令面板条目：aliases[0] 作为面板里展示的命令 token */
export interface ComposerCommand {
  id: string;
  label: string;
  hint?: string;
  aliases?: string[];
}

/** $ / @ 引用面板条目：insert 为插入正文的引用 token（不含触发符） */
export interface MentionItem {
  kind: "skill" | "plugin" | "file";
  name: string;
  detail?: string;
  insert: string;
}

export type MentionTrigger = "$" | "@";

const MENTION_KIND_LABEL: Record<MentionItem["kind"], string> = {
  skill: "技能",
  plugin: "插件",
  file: "文件",
};

export function Composer({
  running,
  onSend,
  onAbort,
  toolbar,
  trailing,
  projectName,
  commands,
  onCommand,
  resolveMentions,
}: {
  running: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
  /** 输入卡底部左侧工具（权限模式等） */
  toolbar?: ReactNode;
  /** 输入卡底部右侧组（模型/思考，与发送按钮等间距排列） */
  trailing?: ReactNode;
  /** 项目名：显示在输入卡上方 */
  projectName?: string;
  /** 斜杠命令面板（行首 / 唤起） */
  commands?: ComposerCommand[];
  onCommand?: (id: string) => void;
  /** $ / @ 引用面板（技能/插件/文件），由调用方按触发符解析候选 */
  resolveMentions?: (trigger: MentionTrigger, query: string) => Promise<MentionItem[]>;
}) {
  const [text, setText] = useState("");
  const [hi, setHi] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [caret, setCaret] = useState<number | null>(null);
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  // ── 触发器识别 ──
  // 行首 / = 命令面板；$ / @ = 引用面板（光标前最后一个「触发符+token」，可嵌在句中）
  const beforeCaret = text.slice(0, caret ?? text.length);
  const slashQuery =
    text.startsWith("/") && !text.includes("\n") ? text.slice(1).trim().toLowerCase() : null;
  const triggerMatch = /(?:^|[\s(\[（【])([$@])([\w\u4e00-\u9fa5./\\-]*)$/.exec(beforeCaret);
  const trigger = (triggerMatch?.[1] ?? null) as MentionTrigger | null;
  const mentionQuery = triggerMatch?.[2] ?? "";
  const tokenStart =
    triggerMatch === null ? 0 : triggerMatch.index + triggerMatch[0].length - mentionQuery.length - 1;

  // 引用候选异步解析（轻防抖：连续敲字不狂发 IPC）
  useEffect(() => {
    if (trigger === null || !resolveMentions) {
      setMentionItems([]);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      resolveMentions(trigger, mentionQuery)
        .then((items) => {
          if (alive) setMentionItems(items);
        })
        .catch(() => {
          if (alive) setMentionItems([]);
        });
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [trigger, mentionQuery, resolveMentions]);

  const commandMatches =
    slashQuery === null || !commands || !onCommand || dismissed
      ? []
      : commands.filter(
          (c) =>
            c.aliases?.some((a) => a.startsWith(slashQuery)) ||
            c.label.toLowerCase().includes(slashQuery),
        );
  const mentionOpen =
    trigger !== null && !!resolveMentions && !dismissed && mentionItems.length > 0;
  const paletteOpen = commandMatches.length > 0 || mentionOpen;
  const popupCount = commandMatches.length > 0 ? commandMatches.length : mentionItems.length;

  useEffect(() => setHi(0), [slashQuery, trigger, mentionQuery]);
  useEffect(() => setDismissed(false), [text]);

  const pickCommand = (cmd: ComposerCommand) => {
    setText("");
    setDismissed(false);
    onCommand?.(cmd.id);
    ref.current?.focus();
  };

  const pickMention = (item: MentionItem) => {
    const c = caret ?? text.length;
    const next = text.slice(0, tokenStart) + item.insert + " " + text.slice(c);
    setText(next);
    setDismissed(false);
    const pos = tokenStart + item.insert.length + 1;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
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
          <div className="cmd-palette" role="listbox" aria-label="候选列表">
            {commandMatches.length > 0
              ? commandMatches.map((c, i) => (
                  <button
                    key={c.id}
                    type="button"
                    className={i === hi ? "cmd-item on" : "cmd-item"}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickCommand(c);
                    }}
                    onMouseEnter={() => setHi(i)}
                  >
                    <span className="cmd-token">/{c.aliases?.[0] ?? c.id}</span>
                    <span className="cmd-label">{c.label}</span>
                    {c.hint && <span className="cmd-hint">{c.hint}</span>}
                  </button>
                ))
              : mentionItems.map((m, i) => (
                  <button
                    key={`${m.kind}-${m.name}`}
                    type="button"
                    className={i === hi ? "cmd-item on" : "cmd-item"}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickMention(m);
                    }}
                    onMouseEnter={() => setHi(i)}
                  >
                    <span className={`cmd-kind kind-${m.kind}`}>{MENTION_KIND_LABEL[m.kind]}</span>
                    <span className="cmd-label mono">{m.name}</span>
                    {m.detail && <span className="cmd-hint">{m.detail}</span>}
                  </button>
                ))}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={
            running
              ? "运行中…可点击下方停止"
              : "输入消息，/ 命令，$ 技能，@ 插件/文件，Enter 发送"
          }
          onChange={(e) => setText(e.target.value)}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={(e) => {
            if (paletteOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHi((i) => Math.min(i + 1, popupCount - 1));
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
                if (commandMatches.length > 0) pickCommand(commandMatches[hi] ?? commandMatches[0]!);
                else {
                  const item = mentionItems[hi] ?? mentionItems[0]!;
                  if (item) pickMention(item);
                }
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
          <div className="composer-trailing">
            {trailing}
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
    </div>
  );
}
