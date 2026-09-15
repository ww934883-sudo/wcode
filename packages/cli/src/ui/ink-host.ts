import type { AgentEvent, AgentHost, PermissionDecision, PermissionRequest } from "@wcode/core";
import type { TodoItem } from "@wcode/core";

export type HistoryItem =
  | { kind: "welcome"; text: string }
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "note"; text: string }
  | { kind: "tool"; name: string; ok: boolean; summary: string; durationMs: number }
  | { kind: "usage"; tokensIn: number; tokensOut: number }
  | { kind: "todos"; todos: TodoItem[] }
  | { kind: "error"; text: string }
  | { kind: "compacted"; note: string }
  | { kind: "permission"; toolName: string; decision: PermissionDecision };

export interface UiState {
  busy: boolean;
  streamingText: string;
  activeTool: string | null;
  todos: TodoItem[];
  permission: PermissionRequest | null;
  /**
   * 历史项（append-only）。注意必须「不可变追加」（每次换新数组）：
   * ink <Static> 用 useMemo([items, index]) 缓存待打印切片，
   * 原地 push（引用不变）会让新条目被静默跳过。
   */
  history: HistoryItem[];
}

type Listener = () => void;

/**
 * InkHost：AgentHost 的 ink 实现（接缝三的第二实现）。
 * 事件写入可变 UiState，通过版本号 + useSyncExternalStore 驱动 React 重渲染；
 * text_delta 高频更新按 ~40ms 合帧；已完成内容进 history 交给 <Static> 打入回滚区。
 */
export class InkHost implements AgentHost {
  state: UiState = {
    busy: false,
    streamingText: "",
    activeTool: null,
    todos: [],
    permission: null,
    history: [],
  };

  version = 0;

  private listeners = new Set<Listener>();
  private scheduled = false;
  private permissionResolve: ((d: PermissionDecision) => void) | null = null;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = (): number => this.version;

  private touch(immediate = false): void {
    if (immediate) {
      this.scheduled = false;
      this.version++;
      for (const l of this.listeners) l();
      return;
    }
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      this.version++;
      for (const l of this.listeners) l();
    }, 40);
  }

  /** App 主动追加历史（欢迎语、用户回显等，不属于 AgentEvent） */
  pushHistory(item: HistoryItem): void {
    this.state.history = [...this.state.history, item];
    this.touch(true);
  }

  setBusy(busy: boolean): void {
    this.state.busy = busy;
    if (!busy) this.flushStreaming();
    this.touch(true);
  }

  private flushStreaming(): void {
    if (this.state.streamingText) {
      this.state.history = [
        ...this.state.history,
        { kind: "assistant", text: this.state.streamingText },
      ];
      this.state.streamingText = "";
    }
    this.state.activeTool = null;
  }

  emit(event: AgentEvent): void {
    switch (event.type) {
      case "text_delta":
        this.state.streamingText += event.text;
        this.touch();
        break;
      case "tool_start":
        this.flushStreaming();
        this.state.activeTool = event.call.name;
        this.touch(true);
        break;
      case "tool_end":
        this.flushStreaming();
        this.pushHistory({
          kind: "tool",
          name: event.toolName,
          ok: event.ok,
          summary: event.summary,
          durationMs: event.durationMs,
        });
        break;
      case "usage":
        this.pushHistory({
          kind: "usage",
          tokensIn: event.cumulative.inputTokens,
          tokensOut: event.cumulative.outputTokens,
        });
        break;
      case "todos_changed":
        this.state.todos = event.todos;
        this.pushHistory({ kind: "todos", todos: event.todos });
        break;
      case "compacted":
        this.pushHistory({ kind: "compacted", note: event.note });
        break;
      case "error":
        this.pushHistory({ kind: "error", text: event.message });
        break;
      case "done":
        this.flushStreaming();
        this.touch(true);
        break;
      case "turn_start":
      default:
        break;
    }
  }

  requestPermission(req: PermissionRequest): Promise<PermissionDecision> {
    this.flushStreaming();
    this.state.permission = req;
    this.touch(true);
    return new Promise<PermissionDecision>((resolve) => {
      this.permissionResolve = (decision) => {
        this.state.permission = null;
        this.pushHistory({ kind: "permission", toolName: req.toolName, decision });
        resolve(decision);
      };
    });
  }

  /** 由权限弹窗组件在用户按键时调用 */
  decide(decision: PermissionDecision): void {
    const resolve = this.permissionResolve;
    this.permissionResolve = null;
    resolve?.(decision);
  }
}
