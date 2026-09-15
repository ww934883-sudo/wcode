import { Box, Text } from "ink";
import React from "react";
import { parseMarkdown, tokenizeInline, type MdBlock } from "../lib/markdown";
import { theme } from "../theme";

/** 行内渲染：**粗体** / `行内码` */
export function Inline({ text }: { text: string }): React.ReactElement {
  const tokens = tokenizeInline(text);
  return (
    <>
      {tokens.map((t, i) =>
        t.type === "bold" ? (
          <Text key={i} bold>
            {t.text}
          </Text>
        ) : t.type === "code" ? (
          <Text key={i} color={theme.accent}>
            {t.text}
          </Text>
        ) : (
          <Text key={i}>{t.text}</Text>
        ),
      )}
    </>
  );
}

function Block({ block }: { block: MdBlock }): React.ReactElement {
  switch (block.kind) {
    case "code":
      return (
        <Box flexDirection="column" paddingLeft={2} borderStyle="round" borderColor={theme.dim}>
          {block.lines.map((l, i) => (
            <Text key={i} color={theme.success}>
              {l}
            </Text>
          ))}
        </Box>
      );
    case "heading":
      return (
        <Text bold color={block.level <= 2 ? theme.accent : undefined}>
          {block.text}
        </Text>
      );
    case "list":
      return (
        <Box flexDirection="column">
          {block.items.map((item, i) => (
            <Text key={i}>
              {block.ordered ? `${i + 1}. ` : "- "}
              <Inline text={item} />
            </Text>
          ))}
        </Box>
      );
    case "para":
    default:
      return (
        <Text>
          <Inline text={block.text} />
        </Text>
      );
  }
}

/** 流式与完成态共用的 markdown 渲染组件 */
export function MarkdownText({ text }: { text: string }): React.ReactElement {
  const blocks = parseMarkdown(text);
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </Box>
  );
}
