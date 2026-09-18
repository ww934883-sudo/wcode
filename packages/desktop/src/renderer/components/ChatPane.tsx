/** 左侧功能栏同款应用图标 */
import brandIcon from "../assets/icon.png";
import type { PermissionDecision } from "@wcode/core";
import type { PermissionAsk, PermissionMode, ThinkingLevel, ModelCatalogGroup } from "../../shared/protocol";
import type { ChatItem, UiState } from "../state";
import { Composer, type ComposerCommand } from "./Composer";
import { ModelSelect } from "./ModelSelect";
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
  catalog,
  providerName,
  model,
  permissionMode,
  thinkingLevel,
  active,
  onActivate,
  onSend,
  onAbort,
  onDecide,
  onFork,
  onRollback,
  onModel,
  onPermissionMode,
  onThinkingLevel,
  onPickFolder,
  onOpenSettings,
  commands,
  onCommand,
}: {
  pane: PaneState;
  catalog: ModelCatalogGroup[];
  /** 当前激活供应商（分组下拉按它定位） */
  providerName: string;
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
  onRollback: (userTurn: number) => void;
  onModel: (provider: string, model: string) => void;
  onPermissionMode: (m: PermissionMode) => void;
  onThinkingLevel: (l: ThinkingLevel) => void;
  onPickFolder: () => void;
  onOpenSettings: () => void;
  /** 斜杠命令面板（透传 Composer） */
  commands?: ComposerCommand[];
  onCommand?: (id: string) => void;
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
      commands={commands}
      onCommand={onCommand}
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
          {pane.ui.usage && (
            <span className="usage">
              ↑{pane.ui.usage.inputTokens} ↓{pane.ui.usage.outputTokens}
            </span>
          )}
        </>
      }
      trailing={
        <>
          <ModelSelect
            catalog={catalog}
            provider={providerName}
            model={model}
            onSelect={onModel}
          />
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
          <div className="home-greeting-row">
            <img
              className="home-greeting-icon"
              src={brandIcon}
              alt="wcode"
              draggable={false}
            />
            <h1 className="home-greeting">{greeting}</h1>
          </div>
          {composer}
          <div className="home-cards">
            <button className="home-card" onClick={onPickFolder}>
              <span className="home-card-icon">📂</span>
              <span className="home-card-title">选择文件夹</span>
              <span className="home-card-desc">打开项目文件夹，AI 帮你编码、调试和重构</span>
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
        onRollback={onRollback}
        onRetry={onSend}
        onOpenSettings={onOpenSettings}
      />
      {composer}
    </section>
  );
}
