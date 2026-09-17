import type { BrowserWindow } from "electron";
import type { AgentEvent, PermissionDecision, PermissionRequest } from "@wcode/core";

/**
 * IPC 宿主（AgentHost 第四实现，接缝三）：事件与权限询问都带 sessionId
 * 多路复用（分屏/多会话）。requestPermission → 渲染层权限卡片，
 * Promise 挂起等待用户决策，与 readline/ink/headless 实现同一模式。
 */
export class IpcHost {
  private seq = 0;
  private pending = new Map<string, (d: PermissionDecision) => void>();

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  emit(sessionId: string, event: AgentEvent): void {
    this.getWindow()?.webContents.send("wcode:event", { sessionId, event });
  }

  async requestPermission(sessionId: string, req: PermissionRequest): Promise<PermissionDecision> {
    const win = this.getWindow();
    if (!win) return "deny";
    const id = `perm-${++this.seq}`;
    const decision = new Promise<PermissionDecision>((resolve) => {
      this.pending.set(id, resolve);
    });
    win.webContents.send("wcode:permission", { id, sessionId, ...req });
    return decision;
  }

  resolve(askId: string, decision: PermissionDecision): void {
    const resolve = this.pending.get(askId);
    this.pending.delete(askId);
    resolve?.(decision);
  }

  /** 窗口销毁时兜底放行所有挂起询问，避免 run() 永久悬挂 */
  dispose(): void {
    for (const resolve of this.pending.values()) resolve("deny");
    this.pending.clear();
  }
}
