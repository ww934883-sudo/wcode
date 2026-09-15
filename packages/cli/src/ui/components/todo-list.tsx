import { Box, Text } from "ink";
import React from "react";
import type { TodoItem } from "@wcode/core";
import { theme } from "../theme";

function iconOf(status: TodoItem["status"]): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[~]";
    default:
      return "[ ]";
  }
}

function colorOf(status: TodoItem["status"]): string | undefined {
  switch (status) {
    case "completed":
      return theme.dim;
    case "in_progress":
      return theme.accent;
    default:
      return undefined;
  }
}

/** 任务清单组件（历史快照与动态区共用） */
export function TodoList({ todos, title }: { todos: TodoItem[]; title?: string }): React.ReactElement {
  if (todos.length === 0) return <></>;
  return (
    <Box flexDirection="column">
      {title ? <Text color={theme.accent}>{title}</Text> : null}
      {todos.map((t, i) => (
        <Text key={i} color={colorOf(t.status)} dimColor={t.status === "completed"}>
          {iconOf(t.status)} {t.content}
          {t.priority ? `（${t.priority}）` : ""}
        </Text>
      ))}
    </Box>
  );
}
