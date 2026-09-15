import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  levelAtLeast,
  type Logger,
  type LogLevel,
} from "./port";
import { redactDeep, redactText } from "./redact";

export interface FileLoggerOptions {
  /** 日志目录，缺省不落盘（仅 console），如 ~/.wcode/logs */
  dir?: string;
  /** 日志文件名（不含扩展名），如 sessionId */
  name?: string;
  level?: LogLevel;
  /** 绑定字段，如 { sessionId } */
  bindings?: Record<string, unknown>;
  /** console 输出同步级别，默认 error */
  consoleLevel?: LogLevel;
}

/**
 * JSONL 文件日志。默认实现极简（零依赖），接口稳定，
 * 未来可无缝替换为 pino 适配器（架构文档 §4.2 的 redact 管道不变）。
 * 目录不可写时自动降级为仅 console，不影响主流程（SessionIOError 策略同理）。
 */
export function createFileLogger(opts: FileLoggerOptions = {}): Logger {
  const level = opts.level ?? "info";
  const consoleLevel = opts.consoleLevel ?? "error";
  const bindings = opts.bindings ?? {};
  const filePath =
    opts.dir && opts.name ? join(opts.dir, `${opts.name}.log`) : undefined;

  const write = (lvl: LogLevel, msg: string, data?: Record<string, unknown>) => {
    if (!levelAtLeast(lvl, level)) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: lvl,
      msg: redactText(msg),
      ...bindings,
      ...(data ? (redactDeep(data) as Record<string, unknown>) : {}),
    });
    if (filePath) {
      // 文件写入失败静默降级：日志永远不能拖垮主流程
      void appendFile(filePath, line + "\n", "utf8").catch(() => {});
    }
    if (levelAtLeast(lvl, consoleLevel)) {
      // eslint-disable-next-line no-console
      console.error(line);
    }
  };

  if (filePath) {
    void mkdir(dirname(filePath), { recursive: true }).catch(() => {});
  }

  return {
    debug: (msg, data) => write("debug", msg, data),
    info: (msg, data) => write("info", msg, data),
    warn: (msg, data) => write("warn", msg, data),
    error: (msg, data) => write("error", msg, data),
    child: (extra) =>
      createFileLogger({ ...opts, bindings: { ...bindings, ...extra } }),
  };
}
