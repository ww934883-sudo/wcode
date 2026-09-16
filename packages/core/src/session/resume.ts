import type { Message } from "../types";
import type { SessionLine } from "./store";

/** 从会话存储行中重放消息历史（损坏行已在两种实现的 load() 容错） */
export function messagesFromSessionLines(lines: SessionLine[]): Message[] {
  return lines
    .filter((l): l is Extract<SessionLine, { type: "message" }> => l.type === "message")
    .map((l) => l.message);
}
