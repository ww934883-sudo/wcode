import { Box, Text } from "ink";
import React from "react";
import { theme } from "../theme";
import { Spinner } from "./spinner";

/** 工具调用行：⏺ 名称 + 结果摘要（完成态，进 Static 历史） */
export function ToolLine({
  name,
  ok,
  summary,
  durationMs,
}: {
  name: string;
  ok: boolean;
  summary: string;
  durationMs: number;
}): React.ReactElement {
  return (
    <Box>
      <Text color={ok ? theme.accent : theme.error}>⏺ </Text>
      <Text bold={ok}>{name}</Text>
      <Text dimColor>
        {"  "}
        {ok ? "" : "失败: "}
        {summary.length > 110 ? summary.slice(0, 107) + "..." : summary} ({durationMs}ms)
      </Text>
    </Box>
  );
}

/** 运行中的工具行（动态区）：旋转圆圈 + 工具名 */
export function ToolRunning({ name }: { name: string }): React.ReactElement {
  return (
    <Box>
      <Spinner label={name} color={theme.accent} />
    </Box>
  );
}
