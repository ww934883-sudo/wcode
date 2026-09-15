import { Box, Text } from "ink";
import React from "react";
import type { DiffLine } from "../lib/diff";
import { theme } from "../theme";

/** diff 着色渲染（权限弹窗内使用） */
export function DiffView({ lines }: { lines: DiffLine[] }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {lines.map((l, i) => {
        switch (l.type) {
          case "meta":
            return (
              <Text key={i} dimColor>
                {l.text}
              </Text>
            );
          case "del":
            return (
              <Text key={i} color={theme.error}>
                - {l.text}
              </Text>
            );
          case "add":
            return (
              <Text key={i} color={theme.success}>
                + {l.text}
              </Text>
            );
          case "ctx":
          default:
            return (
              <Text key={i} dimColor>
                {"  "}
                {l.text}
              </Text>
            );
        }
      })}
    </Box>
  );
}
