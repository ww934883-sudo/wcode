export interface TruncateResult {
  text: string;
  truncated: boolean;
}

/**
 * 通用输出截断（架构文档 §2.7 truncate 阶段）：
 * 保留头 1/3 + 尾 2/3（尾部往往是报错），并附「如何拿到更多」的教学提示。
 * 这是全项目所有工具输出共用的最后一道闸。
 */
export function truncateOutput(text: string, maxChars: number): TruncateResult {
  if (text.length <= maxChars) return { text, truncated: false };
  const headLen = Math.floor(maxChars / 3);
  const tailLen = maxChars - headLen;
  const omitted = text.length - headLen - tailLen;
  const marker =
    `\n...[输出已截断，省略 ${omitted} 字符。` +
    `请改用 offset/limit 分页、缩小搜索路径或收窄匹配模式后重试。]\n`;
  return {
    text: text.slice(0, headLen) + marker + text.slice(text.length - tailLen),
    truncated: true,
  };
}
