/**
 * 错误分类与恢复策略（架构文档 §3.2）：
 * 只有 ConfigError 与不可重试的 ProviderError 允许终止进程，
 * 其余错误一律转化为循环内反馈信号。
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, opts: { retryable: boolean; status?: number }) {
    super(message);
    this.name = "ProviderError";
    this.retryable = opts.retryable;
    this.status = opts.status;
  }
}

/** 用户中断（ESC / SIGINT），穿透工具与管道，不被当作工具错误 */
export class AbortedError extends Error {
  constructor(message = "操作已中断") {
    super(message);
    this.name = "AbortedError";
  }
}

export function isAbortedError(err: unknown): boolean {
  return (
    err instanceof AbortedError ||
    (err instanceof Error && err.name === "AbortError")
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
