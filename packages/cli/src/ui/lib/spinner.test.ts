import { describe, expect, it } from "vitest";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS, spinnerFrame } from "./spinner";

describe("spinner", () => {
  it("帧序列按 tick 递进并在末尾回绕", () => {
    expect(spinnerFrame(0)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrame(1)).toBe(SPINNER_FRAMES[1]);
    expect(spinnerFrame(SPINNER_FRAMES.length)).toBe(SPINNER_FRAMES[0]); // 回绕
    expect(spinnerFrame(SPINNER_FRAMES.length + 2)).toBe(SPINNER_FRAMES[2]);
  });

  it("负数 tick 安全取模", () => {
    expect(spinnerFrame(-1)).toBe(SPINNER_FRAMES[SPINNER_FRAMES.length - 1]);
    expect(spinnerFrame(-SPINNER_FRAMES.length)).toBe(SPINNER_FRAMES[0]);
  });

  it("帧率与帧数约定：10 帧、80ms 间隔（≈12.5fps）", () => {
    expect(SPINNER_FRAMES.length).toBe(10);
    expect(SPINNER_INTERVAL_MS).toBe(80);
  });
});
