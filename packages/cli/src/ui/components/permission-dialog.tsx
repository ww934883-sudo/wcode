import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import type { PermissionDecision, PermissionRequest } from "@wcode/core";
import { rawModeSupported } from "../lib/tty";
import { buildDiffPreview, type DiffLine } from "../lib/diff";
import { readFile } from "node:fs/promises";
import { DiffView } from "./diff-view";
import { theme } from "../theme";

/** 权限确认弹窗：diff 预览 + y/a/n 键盘决策（Promise 桥接 InkHost.requestPermission） */
export function PermissionDialog({
  request,
  onDecision,
}: {
  request: PermissionRequest;
  onDecision: (decision: PermissionDecision) => void;
}): React.ReactElement {
  const [preview, setPreview] = useState<DiffLine[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void buildDiffPreview(request, async (p) => {
      try {
        return await readFile(p, "utf8");
      } catch {
        return null;
      }
    })
      .then((d) => {
        if (!cancelled) setPreview(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [request]);

  if (rawModeSupported) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- rawModeSupported 进程级恒定
    useInput((input, key) => {
      if (key.escape) {
        onDecision("deny");
        return;
      }
      const k = input.toLowerCase();
      if (k === "y") onDecision("allow");
      else if (k === "a") onDecision("allowAlways");
      else if (k === "n") onDecision("deny");
    });
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warn} paddingX={1}>
      <Text color={theme.warn} bold>
        需要权限: {request.toolName}
      </Text>
      {request.patterns.length > 0 ? (
        <Text dimColor> 匹配: {request.patterns.join(", ")}</Text>
      ) : null}
      {preview ? (
        <DiffView lines={preview} />
      ) : (
        <Text dimColor>
          {" "}
          {JSON.stringify(request.input).slice(0, 400)}
        </Text>
      )}
      <Text>
        允许执行?{" "}
        <Text color={theme.success} bold>
          [y]
        </Text>{" "}
        是,{" "}
        <Text color={theme.accent} bold>
          [a]
        </Text>{" "}
        总是允许,{" "}
        <Text color={theme.error} bold>
          [n]
        </Text>
        /Esc 否
      </Text>
    </Box>
  );
}
