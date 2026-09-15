import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import type { TodoItem } from "@wcode/core";
import { rawModeSupported } from "../lib/tty";
import { MarkdownText } from "./message";
import { ToolRunning } from "./tool-line";
import { TodoList } from "./todo-list";
import { theme } from "../theme";

interface InputBoxProps {
  busy: boolean;
  streamingText: string;
  activeTool: string | null;
  todos: TodoItem[];
  onSubmit: (text: string) => void;
}

/** 底部动态区：busy 时显示流式内容/运行中工具/todo，空闲时显示输入框（含历史上下翻） */
export function InputBox(props: InputBoxProps): React.ReactElement {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);

  if (rawModeSupported) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- rawModeSupported 进程级恒定，hooks 顺序稳定
    useInput(
      (input, key) => {
        if (props.busy) return;
        if (key.return) {
          const text = value.trim();
          if (!text) return;
          setHistory((h) => [...h, text]);
          setHistoryIdx(-1);
          setValue("");
          props.onSubmit(text);
          return;
        }
        if (key.upArrow) {
          if (history.length === 0) return;
          const next = historyIdx < 0 ? history.length - 1 : Math.max(0, historyIdx - 1);
          setHistoryIdx(next);
          setValue(history[next] ?? "");
          return;
        }
        if (key.downArrow) {
          if (historyIdx < 0) return;
          const next = historyIdx + 1;
          if (next >= history.length) {
            setHistoryIdx(-1);
            setValue("");
          } else {
            setHistoryIdx(next);
            setValue(history[next] ?? "");
          }
          return;
        }
        if (key.backspace || key.delete) {
          setValue((v) => v.slice(0, -1));
          return;
        }
        if (key.ctrl || key.meta || key.escape || key.tab) return;
        if (input) setValue((v) => v + input);
      },
      { isActive: !props.busy },
    );
  }

  if (props.busy) {
    return (
      <Box flexDirection="column" paddingTop={1}>
        {props.streamingText ? <MarkdownText text={props.streamingText} /> : null}
        {props.activeTool ? <ToolRunning name={props.activeTool} /> : null}
        {!props.streamingText && !props.activeTool ? (
          <Text dimColor>思考中…</Text>
        ) : null}
        {props.todos.length > 0 ? <TodoList todos={props.todos} title="任务清单:" /> : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingTop={1}>
      <Text>
        <Text color={theme.accent} bold>
          {"> "}
        </Text>
        <Text>{value}</Text>
        <Text inverse> </Text>
      </Text>
      {value === "" ? (
        <Text dimColor>输入任务回车执行；Ctrl+C 中断任务/再按退出</Text>
      ) : null}
    </Box>
  );
}
