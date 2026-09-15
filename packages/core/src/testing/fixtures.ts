import type { AgentEvent, AgentHost, PermissionDecision, PermissionRequest } from "../host/port";
import { createSessionState, type SessionState } from "../session/state";
import type { ToolContext } from "../tools/tool";
import { createFileLogger } from "../logging/file-logger";

export class RecordingHost implements AgentHost {
  events: AgentEvent[] = [];
  permissionRequests: PermissionRequest[] = [];
  /** 队列：按顺序消费；为空时再遇到 ask 直接抛错（测试显式可控） */
  permissionResponses: PermissionDecision[] = [];

  emit(event: AgentEvent): void {
    this.events.push(event);
  }

  async requestPermission(req: PermissionRequest): Promise<PermissionDecision> {
    this.permissionRequests.push(req);
    const decision = this.permissionResponses.shift();
    if (!decision) {
      throw new Error(`意外的权限询问: ${req.toolName} ${JSON.stringify(req.patterns)}`);
    }
    return decision;
  }

  eventsOfType<T extends AgentEvent["type"]>(type: T): Extract<AgentEvent, { type: T }>[] {
    return this.events.filter((e) => e.type === type) as Extract<
      AgentEvent,
      { type: T }
    >[];
  }
}

export function makeSession(cwd: string): SessionState {
  return createSessionState(cwd);
}

export function makeToolContext(
  session: SessionState,
  signal: AbortSignal = new AbortController().signal,
): ToolContext {
  return { session, signal, log: createFileLogger({ level: "error" }) };
}
