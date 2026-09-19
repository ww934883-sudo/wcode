#!/usr/bin/env bash
# 鼠标点击（macOS）：移动到坐标并点击。
# 用法: bash click.sh -x 520 -y 300 [-double] [-right]
# 无第三方依赖走 osascript（右键用 Ctrl+单击模拟，部分应用可能不响应）；
# 装了 cliclick（brew install cliclick）时自动改用，双击/右键更可靠。
# 前置授权：系统设置 → 隐私与安全性 → 辅助功能，勾选运行本脚本的宿主。
# 坐标为逻辑点（屏幕左上角原点），与 screenshot.sh 输出图的 2x 像素坐标除以 2 对应。
set -euo pipefail

x=""; y=""; double=0; right=0
while [ $# -gt 0 ]; do
  case "$1" in
    -x) x="$2"; shift 2 ;;
    -y) y="$2"; shift 2 ;;
    -double) double=1; shift ;;
    -right) right=1; shift ;;
    *) echo "未知参数: $1（用法: bash click.sh -x 520 -y 300 [-double] [-right]）" >&2; exit 2 ;;
  esac
done
if [ -z "$x" ] || [ -z "$y" ]; then
  echo "缺少坐标（用法: bash click.sh -x 520 -y 300 [-double] [-right]）" >&2
  exit 2
fi

# cliclick 优先（c=单击 dc=双击 rc=右键）
if command -v cliclick >/dev/null 2>&1; then
  if [ "$right" = "1" ]; then op="rc"; elif [ "$double" = "1" ]; then op="dc"; else op="c"; fi
  cliclick "${op}:${x},${y}"
  echo "已在 (${x}, ${y}) $(if [ "$double" = "1" ]; then echo 双击; elif [ "$right" = "1" ]; then echo 右键; else echo 单击; fi)（cliclick）"
  exit 0
fi

osascript - "$x" "$y" "$double" "$right" <<'EOF'
on run argv
  set x to (item 1 of argv) as integer
  set y to (item 2 of argv) as integer
  set doubleClick to (item 3 of argv) as integer
  set rightClick to (item 4 of argv) as integer
  tell application "System Events"
    if rightClick = 1 then
      key down control
      click at {x, y}
      key up control
    else
      click at {x, y}
      if doubleClick = 1 then
        delay 0.08
        click at {x, y}
      end if
    end if
  end tell
end run
EOF
echo "已在 (${x}, ${y}) $(if [ "$double" = "1" ]; then echo 双击; elif [ "$right" = "1" ]; then echo 右键; else echo 单击; fi)（osascript）"
