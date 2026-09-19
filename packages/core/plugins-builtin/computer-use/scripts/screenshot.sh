#!/usr/bin/env bash
# 屏幕截图（macOS）：全屏或区域，保存为 PNG。
# 用法: bash screenshot.sh [-o shot.png] [-x 0 -y 0 -w 800 -h 600]
# 坐标为逻辑点（屏幕左上角原点）；Retina 屏输出的 PNG 是 2x 物理像素，看图时注意。
# 前置授权：系统设置 → 隐私与安全性 → 屏幕录制，勾选运行本脚本的宿主（终端/wcode），
# 未授权时截图会失败或输出空图，授权后需重跑。
set -euo pipefail

out="screenshot.png"
x=""; y=""; w=""; h=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -x) x="$2"; shift 2 ;;
    -y) y="$2"; shift 2 ;;
    -w) w="$2"; shift 2 ;;
    -h) h="$2"; shift 2 ;;
    *) echo "未知参数: $1（用法: bash screenshot.sh [-o shot.png] [-x 0 -y 0 -w 800 -h 600]）" >&2; exit 2 ;;
  esac
done

args=(-x)
if [ -n "$x" ] && [ -n "$y" ] && [ -n "$w" ] && [ -n "$h" ]; then
  args+=(-R"${x},${y},${w},${h}")
fi
args+=("$out")

if ! screencapture "${args[@]}" 2>&1; then
  echo "截图失败：请检查屏幕录制授权（系统设置 → 隐私与安全性 → 屏幕录制）" >&2
  exit 1
fi
abs="$(cd "$(dirname "$out")" && pwd)/$(basename "$out")"
echo "已保存: ${abs}"
