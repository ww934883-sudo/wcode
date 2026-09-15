/** 非 TTY（管道/CI）下 ink 的 useInput 会因无法开 raw mode 而抛错；
 * 该值进程级恒定，可在组件里安全地条件化 useInput（hooks 顺序稳定）。 */
export const rawModeSupported =
  process.stdin.isTTY === true && typeof process.stdin.setRawMode === "function";
