---
name: control-desktop
description: 需要控制本机桌面/图形界面时使用——屏幕截图查看界面、鼠标点击、键盘输入、管理窗口与进程。纯命令行能完成的任务（读写文件、跑脚本）不要用键鼠操作。
---

# 电脑控制（桌面自动化）

脚本路径已用 `${WCODE_PLUGIN_ROOT}` 写死；所有命令都是**真实生效**的系统操作，
执行键鼠动作前先向用户确认目标窗口/应用，不要操作用户未授权的应用。

Windows 优先（脚本开箱即用）；macOS/Linux 等价命令见文末。

## 1. 截图（先看再动）

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File "${WCODE_PLUGIN_ROOT}/scripts/screenshot.ps1" -Out shot.png
# 区域截图：-X -Y -W -H（物理像素）
```

然后用 read 工具查看图片，确认界面状态再决定点击坐标。坐标以**屏幕左上角为原点**。

## 2. 鼠标点击

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File "${WCODE_PLUGIN_ROOT}/scripts/click.ps1" -X 520 -Y 300
# 双击加 -Double；右键加 -Right
```

## 3. 键盘输入

```bash
# 先聚焦目标窗口（可选），再发按键
powershell -NoProfile -ExecutionPolicy Bypass -File "${WCODE_PLUGIN_ROOT}/scripts/keys.ps1" -Keys "hello{ENTER}" -AppTitle "记事本"
```

SendKeys 语法：普通字符原样发送；`{ENTER}` `{TAB}` `{DEL}` `{F5}` `{LEFT}` `{PGDN}` 等特殊键；
`+` Shift、`^` Ctrl、`%` Alt（如 `^s` = Ctrl+S、`%{F4}` = Alt+F4、`+abc` = ABC）。

## 4. 窗口与进程（直接用 bash + powershell）

```bash
powershell -NoProfile -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name, Id, CPU"
powershell -NoProfile -Command "Get-Process notepad | Select-Object Id, MainWindowTitle"
powershell -NoProfile -Command "Start-Process notepad"
```

杀进程属于破坏性操作：先 `Get-Process` 确认目标，向用户说明后执行
`powershell -NoProfile -Command "Stop-Process -Id <pid> -Force"`。

## 5. 推荐工作流

1. 截图看现状 → 2. 激活目标窗口（keys.ps1 -AppTitle）→ 3. 键鼠操作 → 4. 再截图验证结果。
循环进行，每步验证，避免盲点。

## macOS / Linux 等价

- 截图：macOS `screencapture -x out.png`；Linux `import out.png`（ImageMagick）或 `gnome-screenshot -f out.png`。
- 键鼠：macOS `osascript -e 'tell application "System Events" to keystroke "hi"'`；
  Linux `xdotool key Return`、`xdotool mousemove 520 300 click 1`。
- 本插件脚本不覆盖这两个平台时，直接用上述命令行工具替代。
