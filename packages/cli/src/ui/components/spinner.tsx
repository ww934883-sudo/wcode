import { Text } from "ink";
import React, { useEffect, useState } from "react";
import { SPINNER_INTERVAL_MS, spinnerFrame } from "../lib/spinner";

/** 动态指示器：braille 圆圈旋转。思考中 / 运行中工具行共用；卸载时清掉定时器 */
export function Spinner({
  label,
  color,
}: {
  label: string;
  /** 缺省灰显；传入主题色时按色渲染（工具行用 accent） */
  color?: string;
}): React.ReactElement {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text dimColor={color === undefined} color={color}>
      {spinnerFrame(tick)} {label}…
    </Text>
  );
}
