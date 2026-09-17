import type { Message } from "../types";
import type { SessionLine } from "./store";

/**
 * 从会话存储行中重放消息历史（损坏行已在两种实现的 load() 容错）。
 * truncate 标记把历史截断为前 keepMessages 条（原地回退）；多次回退按顺序叠加，
 * 后续新消息接在最近一次截断点上。
 */
export function messagesFromSessionLines(lines: SessionLine[]): Message[] {
  const out: Message[] = [];
  for (const l of lines) {
    if (l.type === "message") {
      out.push(l.message);
    } else if (l.type === "truncate" && l.keepMessages < out.length) {
      out.length = Math.max(0, l.keepMessages);
    }
  }
  return out;
}
