import { AbortedError, isAbortedError, ProviderError } from "@wcode/core";

export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * SSE data 行迭代器：按行缓冲、只产出 data: 载荷；[DONE] 结束。
 * 流中断无副作用可重试；用户中断翻译为 AbortedError。
 */
export async function* iterateSseData(
  res: Response,
  signal: AbortSignal,
): AsyncIterable<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    throw new ProviderError("响应无内容流", { retryable: false });
  }
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineAt: number;
      while ((newlineAt = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineAt).trim();
        buffer = buffer.slice(newlineAt + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") return;
        yield data;
      }
    }
  } catch (err) {
    if (isAbortedError(err) || signal.aborted) throw new AbortedError();
    throw new ProviderError(`流中断: ${describe(err)}`, { retryable: true });
  }
}

export async function toOpenAIProviderError(
  res: Response,
  label: string,
): Promise<ProviderError> {
  let apiMessage = "";
  try {
    const data = (await res.json()) as { error?: { message?: string } };
    apiMessage = data.error?.message ?? "";
  } catch {
    apiMessage = await res.text().catch(() => "");
  }
  const status = res.status;
  const retryable = status === 408 || status === 429 || status >= 500;
  const hint =
    status === 401 || status === 403
      ? "（请检查 API key 与权限）"
      : status === 429
        ? "（限流，将自动重试）"
        : status === 404
          ? "（检查 baseUrl 是否指向协议正确的端点）"
          : "";
  return new ProviderError(`${label} ${status}: ${apiMessage || res.statusText}${hint}`, {
    retryable,
    status,
  });
}
