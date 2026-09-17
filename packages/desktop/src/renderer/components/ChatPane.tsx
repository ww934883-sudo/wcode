import type { PermissionDecision } from "@wcode/core";
import type { PermissionAsk, PermissionMode, ThinkingLevel } from "../../shared/protocol";
import type { ChatItem, UiState } from "../state";
import { Composer } from "./Composer";
import { ChatView } from "./ChatView";

export interface PaneState {
  sessionId: string | null;
  cwd: string;
  ui: UiState;
}

const PERMISSION_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: "default", label: "请求批准" },
  { value: "acceptEdits", label: "自动批准编辑" },
  { value: "bypass", label: "完全访问" },
  { value: "plan", label: "计划模式" },
];

const THINKING_OPTIONS: { value: ThinkingLevel; label: string }[] = [
  { value: "off", label: "思考: 关闭" },
  { value: "low", label: "思考: 低" },
  { value: "medium", label: "思考: 中" },
  { value: "high", label: "思考: 高" },
];

/** 单个聊天面板：空状态=居中欢迎页（问候+输入卡+引导卡），有消息=会话流+底部输入卡 */
export function ChatPane({
  pane,
  models,
  model,
  permissionMode,
  thinkingLevel,
  active,
  onActivate,
  onSend,
  onAbort,
  onDecide,
  onFork,
  onModel,
  onPermissionMode,
  onThinkingLevel,
  onPickFolder,
  onOpenSettings,
  onOpenAssistant,
}: {
  pane: PaneState;
  models: string[];
  model: string;
  permissionMode: PermissionMode;
  thinkingLevel: ThinkingLevel;
  /** 分屏时的激活面板（单面板恒 false） */
  active: boolean;
  onActivate: () => void;
  onSend: (text: string) => void;
  onAbort: () => void;
  onDecide: (askId: string, decision: PermissionDecision) => void;
  onFork: (userTurn: number) => void;
  onModel: (m: string) => void;
  onPermissionMode: (m: PermissionMode) => void;
  onThinkingLevel: (l: ThinkingLevel) => void;
  onPickFolder: () => void;
  onOpenSettings: () => void;
  onOpenAssistant: () => void;
}) {
  const curAsk = pane.ui.items.find(
    (it): it is Extract<ChatItem, { kind: "permission" }> =>
      it.kind === "permission" && it.decided === undefined,
  );

  const greeting = (() => {
    const h = new Date().getHours();
    const word = h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好";
    return `${word}，想做点什么？`;
  })();

  const composer = (
    <Composer
      running={pane.ui.running}
      onSend={onSend}
      onAbort={onAbort}
      projectName={pane.cwd.split(/[\\/]/).pop() || pane.cwd}
      toolbar={
        <>
          <select
            className="sel"
            value={permissionMode}
            title="权限模式（新会话生效）"
            onChange={(e) => onPermissionMode(e.target.value as PermissionMode)}
          >
            {PERMISSION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <div className="pane-toolbar">
            <select
              className="sel"
              value={model}
              title="模型（即时切换，空闲会话生效）"
              onChange={(e) => onModel(e.target.value)}
            >
              {(models.length > 0 ? models : [model]).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <select
              className="sel"
              value={thinkingLevel}
              title="思考级别（下一轮请求生效）"
              onChange={(e) => onThinkingLevel(e.target.value as ThinkingLevel)}
            >
              {THINKING_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {pane.ui.usage && (
              <span className="usage">
                ↑{pane.ui.usage.inputTokens} ↓{pane.ui.usage.outputTokens}
              </span>
            )}
          </div>
        </>
      }
    />
  );

  // 空状态：CodePilot 式欢迎页（居中问候 + 输入卡 + 引导卡）
  if (pane.ui.items.length === 0) {
    return (
      <section className={"pane" + (active ? " active" : "")} onClick={onActivate}>
        {curAsk && (
          <div className="pane-ask-hint">有待处理的权限确认：{curAsk.toolName}</div>
        )}
        <div className="home">
          <h1 className="home-greeting">{greeting}</h1>
          {composer}
          <div className="home-cards">
            <button className="home-card" onClick={onPickFolder}>
              <span className="home-card-icon">📂</span>
              <span className="home-card-title">选择文件夹</span>
              <span className="home-card-desc">打开项目文件夹，AI 帮你编码、调试和重构</span>
            </button>
            <button className="home-card" onClick={onOpenAssistant}>
              <span className="home-card-icon">🤖</span>
              <span className="home-card-title">个人助理</span>
              <span className="home-card-desc">设置一个记住你偏好、辅助创作的 AI</span>
            </button>
            <button className="home-card" onClick={onOpenSettings}>
              <span className="home-card-icon">🔑</span>
              <span className="home-card-title">配置 API 服务商</span>
              <span className="home-card-desc">录入 key，切换到真实模型对话</span>
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={"pane" + (active ? " active" : "")} onClick={onActivate}>
      {curAsk && (
        <div className="pane-ask-hint">有待处理的权限确认：{curAsk.toolName}</div>
      )}
      <ChatView
        ui={pane.ui}
        onDecide={onDecide}
        onSuggest={onSend}
        onFork={onFork}
        onRetry={onSend}
        onOpenSettings={onOpenSettings}
      />
      {composer}
    </section>
  );
}
