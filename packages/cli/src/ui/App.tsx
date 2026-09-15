import { Box, Static, Text, useApp, useInput } from "ink";
import React, { useState } from "react";
import type { InkHost, HistoryItem } from "./ink-host";
import { rawModeSupported } from "./lib/tty";
import { MarkdownText } from "./components/message";
import { ToolLine } from "./components/tool-line";
import { TodoList } from "./components/todo-list";
import { PermissionDialog } from "./components/permission-dialog";
import { InputBox } from "./components/input-box";
import { theme } from "./theme";

function HistoryItemView({ item }: { item: HistoryItem }): React.ReactElement {
  switch (item.kind) {
    case "welcome":
      return (
        <Text color={theme.accent} bold>
          {item.text}
        </Text>
      );
    case "user":
      return (
        <Text color={theme.user} bold>
          ❯ {item.text}
        </Text>
      );
    case "assistant":
      return <MarkdownText text={item.text} />;
    case "note":
      return <Text dimColor>{item.text}</Text>;
    case "tool":
      return <ToolLine name={item.name} ok={item.ok} summary={item.summary} durationMs={item.durationMs} />;
    case "usage":
      return (
        <Text dimColor>
          [tokens: in {item.tokensIn} / out {item.tokensOut}]
        </Text>
      );
    case "todos":
      return <TodoList todos={item.todos} title="任务清单:" />;
    case "error":
      return (
        <Text color={theme.error}>
          ! {item.text}
        </Text>
      );
    case "compacted":
      return (
        <Text color={theme.warn}>
          ⊗ {item.note}
        </Text>
      );
    case "permission":
      return (
        <Text dimColor>
          权限 {item.toolName} →{" "}
          {item.decision === "allow"
            ? "允许"
            : item.decision === "allowAlways"
              ? "总是允许"
              : "拒绝"}
        </Text>
      );
    default:
      return <Text> </Text>;
  }
}

interface AppProps {
  host: InkHost;
  onSubmit: (text: string) => Promise<void>;
  onAbort: () => void;
}

export function App({ host, onSubmit, onAbort }: AppProps): React.ReactElement {
  useSyncExternalStoreShim(host);
  const { exit } = useApp();
  const [lastCtrlC, setLastCtrlC] = useState(0);

  if (rawModeSupported) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- rawModeSupported 进程级恒定
    useInput((input, key) => {
      if (key.ctrl && input === "c") {
        const now = Date.now();
        if (host.state.busy) {
          onAbort();
          return;
        }
        if (now - lastCtrlC < 2000) {
          exit();
        } else {
          setLastCtrlC(now);
          host.pushHistory({ kind: "error", text: "再按一次 Ctrl+C 退出 wcode" });
        }
      }
    });
  }

  const handleSubmit = (text: string): void => {
    if (text === "/quit" || text === "/exit") {
      exit();
      return;
    }
    host.pushHistory({ kind: "user", text });
    host.setBusy(true);
    void onSubmit(text).finally(() => host.setBusy(false));
  };

  return (
    <Box flexDirection="column">
      <Static items={host.state.history}>
        {(item, index) => (
          <Box key={index} marginBottom={index === host.state.history.length - 1 ? 1 : 0}>
            <HistoryItemView item={item} />
          </Box>
        )}
      </Static>
      {host.state.permission ? (
        <PermissionDialog request={host.state.permission} onDecision={(d) => host.decide(d)} />
      ) : (
        <InputBox
          busy={host.state.busy}
          streamingText={host.state.streamingText}
          activeTool={host.state.activeTool}
          todos={host.state.todos}
          onSubmit={handleSubmit}
        />
      )}
    </Box>
  );
}

/** 把 InkHost 的可变状态接入 React 渲染周期 */
function useSyncExternalStoreShim(host: InkHost): void {
  React.useSyncExternalStore(host.subscribe, host.getVersion, host.getVersion);
}
