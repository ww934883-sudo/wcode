import { AbortedError } from "../errors";

/** 可中断 sleep：abort 时抛 AbortedError，而不是傻等到点 */
export function sleepInterruptible(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 指数退避重试延迟（毫秒），生产默认；测试注入短延迟 */
export const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const;

export const MAX_TURNS_DEFAULT = 50;
export const MAX_OUTPUT_CHARS_DEFAULT = 30_000;
