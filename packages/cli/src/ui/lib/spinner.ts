/** braille 圆圈旋转帧（cli-spinners "dots" 同款），终端通用无字体问题 */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** 帧间隔（ms）：80ms ≈ 12.5fps，动而不闪 */
export const SPINNER_INTERVAL_MS = 80;

/** 纯函数取帧：任意整数（含负数）安全取模，便于单测与外部驱动 */
export function spinnerFrame(tick: number): string {
  const n = SPINNER_FRAMES.length;
  return SPINNER_FRAMES[((tick % n) + n) % n] ?? "⠋";
}
