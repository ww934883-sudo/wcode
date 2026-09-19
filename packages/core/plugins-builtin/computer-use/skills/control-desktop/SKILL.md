---
name: control-desktop
description: 需要控制本机桌面/图形界面时使用——屏幕截图查看界面、鼠标点击、键盘输入、管理窗口与进程。纯命令行能完成的任务（读写文件、跑脚本）不要用键鼠操作。
---

# 电脑控制（桌面自动化）

脚本路径已用 `${WCODE_PLUGIN_ROOT}` 写死；所有命令都是**真实生效**的系统操作，
执行键鼠动作前先向用户确认目标窗口/应用，不要操作用户未授权的应用。

Windows 与 macOS 脚本开箱即用（按平台二选一）；Linux 等价命令见文末。

## 1. 截图（先看再动）

```bash
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File "${WCODE_PLUGIN_ROOT}/scripts/screenshot.ps1" -Out shot.png
# 区域截图：-X -Y -W -H（物理像素）

# macOS
bash "${WCODE_PLUGIN_ROOT}/scripts/screenshot.sh" -o shot.png
# 区域截图：-x -y -w -h（逻辑点；Retina 屏输出图为 2x 像素，换算点击坐标时除以 2）
```

然后用 read 工具查看图片，确认界面状态再决定点击坐标。坐标以**屏幕左上角为原点**。

## 2. 鼠标点击

```bash
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File "${WCODE_PLUGIN_ROOT}/scripts/click.ps1" -X 520 -Y 300
# 双击加 -Double；右键加 -Right

# macOS
bash "${WCODE_PLUGIN_ROOT}/scripts/click.sh" -x 520 -y 300
# 双击加 -double；右键加 -right（无 cliclick 时右键用 Ctrl+单击模拟，装 cliclick 更可靠）
```

## 3. 键盘输入

```bash
# 先聚焦目标窗口（可选），再发按键
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File "${WCODE_PLUGIN_ROOT}/scripts/keys.ps1" -Keys "hello{ENTER}" -AppTitle "记事本"

# macOS
bash "${WCODE_PLUGIN_ROOT}/scripts/keys.sh" -k "hello{ENTER}" -app "TextEdit"
```

SendKeys 语法（两平台脚本共用同一套子集）：普通字符原样发送；`{ENTER}` `{TAB}` `{ESC}`
`{DEL}` `{F5}` `{LEFT}` `{PGDN}` 等特殊键；`+` Shift、`^` Ctrl、`%` Alt/Option
（如 `^s` = Ctrl+S、`%{F4}` = Alt+F4、`+abc` = ABC）。
macOS 脚本另收 mac 风格组合键：`cmd+s`、`cmd+shift+t`（+ 连接，可多层）。
大段含引号/换行的文本在 macOS 上建议走剪贴板：`printf %s "文本" | pbcopy` 后发送 `cmd+v`。

## 4. 窗口与进程（直接用 bash + 平台命令）

```bash
# Windows
powershell -NoProfile -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name, Id, CPU"
powershell -NoProfile -Command "Get-Process notepad | Select-Object Id, MainWindowTitle"
powershell -NoProfile -Command "Start-Process notepad"

# macOS
ps ax -o pid,pcpu,comm | sort -k2 -rn | head -10
osascript -e 'tell application "Finder" to activate'   # 激活应用
open -a "Safari"                                        # 启动应用
```

杀进程属于破坏性操作：先列进程确认目标，向用户说明后执行
`powershell -NoProfile -Command "Stop-Process -Id <pid> -Force"`（Windows）或
`kill <pid>`（macOS/Linux）。

## 5. 推荐工作流

1. 截图看现状 → 2. 激活目标窗口（keys 脚本 -AppTitle/-app）→ 3. 键鼠操作 → 4. 再截图验证结果。
循环进行，每步验证，避免盲点。

## macOS 授权前置

键鼠与截图依赖系统授权（首次使用会失败，授权后重试即可）：

- **屏幕录制**（screenshot.sh）：系统设置 → 隐私与安全性 → 屏幕录制
- **辅助功能**（click.sh / keys.sh）：系统设置 → 隐私与安全性 → 辅助功能

勾选运行 wcode 的宿主（终端 / wcode.app）。未打包的临时脚本调用需授权对应终端应用。

## Linux 等价命令

- 截图：`import out.png`（ImageMagick）或 `gnome-screenshot -f out.png`。
- 键鼠：`xdotool key Return`、`xdotool mousemove 520 300 click 1`。
- 本插件脚本不覆盖 Linux 时，直接用上述命令行工具替代。
