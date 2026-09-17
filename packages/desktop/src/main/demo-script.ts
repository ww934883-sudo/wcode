import type { Message, ModelProvider, ModelRequest, ModelResponse, StreamEvent, ToolCall } from "@wcode/core";
import { endTurn, toolUseTurn } from "@wcode/core/testing";
import { join } from "node:path";

export interface DemoTurn {
  /** 打字机分段：每段单独 yield，段间停顿，模拟真实流式节奏 */
  chunks: string[];
  response: ModelResponse;
}

function call(id: string, name: string, input: unknown): ToolCall {
  return { id, name, input };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 演示 provider（ModelProvider 第六实现）：按脚本轮次循环播放。
 * 工具调用不是演的——read/write 走真实的内置工具与权限引擎，
 * 只有模型输出是脚本，离线可复现、零 token 消耗。
 */
export class ScriptedProvider implements ModelProvider {
  readonly id = "demo";
  readonly model = "wcode-demo";
  private index = 0;

  constructor(private readonly turns: DemoTurn[]) {}

  async listModels(): Promise<string[]> {
    return [this.model];
  }

  async countTokens(_messages: Message[]): Promise<number> {
    return 1;
  }

  async *stream(_req: ModelRequest): AsyncIterable<StreamEvent> {
    const turn = this.turns[this.index % this.turns.length];
    this.index++;
    if (!turn) {
      yield { type: "message_complete", response: endTurn("演示脚本为空") };
      return;
    }
    for (const chunk of turn.chunks) {
      await sleep(26);
      yield { type: "text_delta", text: chunk };
    }
    await sleep(150);
    yield { type: "message_complete", response: turn.response };
  }
}

/** 演示叙事：读 README → 写笔记（触发权限确认）→ 汇报闭环 */
export function buildDemoTurns(cwd: string): DemoTurn[] {
  const readme = join(cwd, "README.md");
  const note = join(cwd, "演示笔记.md");
  return [
    {
      chunks: ["好的，我先看一下这个项目的结构和说明。", "让我读一下 README……"],
      response: toolUseTurn([call("demo-t1", "read", { file_path: readme })]),
    },
    {
      chunks: [
        "看完了。这是 wcode 桌面版演示模式的示例工程，README 里说明了演示脚本会做什么。",
        "我把要点整理成一份笔记保存下来——这一步是**写文件**，你会先看到权限确认卡片。",
      ],
      response: toolUseTurn([
        call("demo-t2", "write", {
          file_path: note,
          content:
            "# 演示笔记\n\n- wcode 桌面版 demo：读文件 → 权限确认 → 写文件 → 汇报\n- 工具真实执行，模型输出为本地脚本，离线可复现\n",
        }),
      ]),
    },
    {
      chunks: [
        "笔记已经保存。",
        "到这里你看到了一个完整闭环：**流式回复 → 工具卡片 → 权限确认 → 结果汇报**。可以继续输入任意内容重播，或配置 API key 后切换到真实模型。",
      ],
      response: endTurn("演示流程结束：已读取 README，写出演示笔记（含一次权限确认）。"),
    },
  ];
}
