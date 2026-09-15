import type { Message } from "../types";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StreamEvent,
} from "../model/port";
import { AbortedError, ProviderError } from "../errors";

export interface FakeTurn {
  /** 正常返回完整响应 */
  response?: ModelResponse;
  /** 立即抛出该错误（测试重试路径） */
  error?: ProviderError;
  /** 流挂起直到 abort（测试中断路径） */
  hang?: boolean;
  /** text_delta 序列（测试 UI 流式渲染） */
  streamText?: string[];
}

/** 便捷构造器 */
export function endTurn(text: string): ModelResponse {
  return {
    stopReason: "end_turn",
    text,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

export function toolUseTurn(toolCalls: ToolCallShape[], text = ""): ModelResponse {
  return {
    stopReason: "tool_use",
    text,
    toolCalls,
    usage: { inputTokens: 20, outputTokens: 8 },
  };
}

type ToolCallShape = ModelResponse["toolCalls"][number];

/** 脚本化 FakeProvider：按轮次依次返回，并记录收到的请求供断言 */
export class FakeProvider implements ModelProvider {
  readonly id = "fake";
  readonly model = "fake-model";
  readonly requests: ModelRequest[] = [];
  private turnIndex = 0;

  constructor(private readonly turns: FakeTurn[]) {}

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    const turn = this.turns[this.turnIndex++];
    if (!turn) {
      throw new ProviderError("FakeProvider 脚本耗尽", { retryable: false });
    }
    if (turn.error) throw turn.error;
    if (turn.hang) {
      await hangUntilAbort(req.signal);
    }
    for (const delta of turn.streamText ?? []) {
      yield { type: "text_delta", text: delta };
    }
    if (turn.response) {
      yield { type: "message_complete", response: turn.response };
    }
  }

  async countTokens(_messages: Message[]): Promise<number> {
    return 1;
  }
}

function hangUntilAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const rejectAborted = () => reject(new AbortedError());
    if (signal.aborted) {
      rejectAborted();
      return;
    }
    signal.addEventListener("abort", rejectAborted, { once: true });
  });
}
