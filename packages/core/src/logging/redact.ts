/**
 * 强制脱敏管道（安全基线 §4.7）：所有日志在落盘前经过这里。
 * 有专项单测，改动正则必须同步补用例。
 */

/** 常见厂商 key 形态，整体替换 */
const API_KEY_LITERAL_RE = /\b(?:sk|fk|rk)-[A-Za-z0-9_-]{8,}\b/g;
/** key=value / key: value 形态（含 .env 行）；捕获组 1 = key+分隔符，替换时保留 */
const KEY_VALUE_RE =
  /((?:(?:api|access)[_-]?key|secret|token|password|authorization|credential)[a-z0-9_-]*\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}"']+)/gi;

/** 对象键名命中即整体打码（用于日志字段脱敏） */
const SENSITIVE_KEY_RE = /(api[_-]?key|secret|token|password|authorization|credential)/i;
const MASK = "[REDACTED]";

export function redactText(text: string): string {
  return text
    .replace(API_KEY_LITERAL_RE, MASK)
    .replace(KEY_VALUE_RE, (_match, prefix: string) => `${prefix}${MASK}`);
}

export function redactDeep<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value instanceof Date) return value;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? MASK : walk(v);
    }
    return out;
  }
  return value;
}
