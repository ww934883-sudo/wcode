#!/usr/bin/env bash
# 键盘输入（macOS）：键入文本或发送按键/组合键。
# 用法: bash keys.sh -k "hello{ENTER}" [-app "Safari"]
# 按键语法（对齐 Windows keys.ps1 的常用子集）：
#   普通文本原样键入；
#   特殊键 {ENTER} {TAB} {ESC} {BACKSPACE} {DEL} {SPACE} {HOME} {END} {PGUP} {PGDN}
#         {UP} {DOWN} {LEFT} {RIGHT} {F1}..{F12}；
#   组合键两种写法等价：mac 风格 cmd+s / cmd+shift+t；SendKeys 风格 ^s（Ctrl）、%x（Option）、+x（Shift）。
# 大段含引号/换行的文本建议走剪贴板：printf %s "文本" | pbcopy，再发送 cmd+v。
# 前置授权：系统设置 → 隐私与安全性 → 辅助功能，勾选运行本脚本的宿主。
set -euo pipefail

keys=""; app=""
while [ $# -gt 0 ]; do
  case "$1" in
    -k) keys="$2"; shift 2 ;;
    -app) app="$2"; shift 2 ;;
    *) echo "未知参数: $1（用法: bash keys.sh -k \"hello{ENTER}\" [-app \"Safari\"]）" >&2; exit 2 ;;
  esac
done
if [ -z "$keys" ]; then
  echo "缺少 -k（用法: bash keys.sh -k \"hello{ENTER}\" [-app \"Safari\"]）" >&2
  exit 2
fi

# 激活目标应用（按进程名包含匹配，等于 keys.ps1 -AppTitle 的角色）
if [ -n "$app" ]; then
  osascript - "$app" <<'EOF'
on run argv
  set appName to item 1 of argv
  tell application "System Events"
    set procs to (every application process whose name contains appName)
    if (count of procs) = 0 then
      error "未找到应用「" & appName & "」。用 ps ax -o comm= 查看现有进程名后重试"
    end if
    set frontmost of item 1 of procs to true
  end tell
end run
EOF
  sleep 0.3
fi

# 特殊键 → AppleScript key code（对齐 SendKeys：{DEL} 是退格）；大小写都收（mac 组合键 cmd+enter 小写）
token_code() {
  case "$1" in
    ENTER|RETURN|enter|return) echo 36 ;;  TAB|tab) echo 48 ;;  ESC|esc) echo 53 ;;
    BACKSPACE|backspace|DEL|del) echo 51 ;;   SPACE|space) echo 49 ;;
    UP|up) echo 126 ;;  DOWN|down) echo 125 ;;  LEFT|left) echo 123 ;;  RIGHT|right) echo 124 ;;
    HOME|home) echo 115 ;;  END|end) echo 119 ;;  PGUP|pgup) echo 116 ;;  PGDN|pgdn) echo 121 ;;
    F1|f1) echo 122 ;;  F2|f2) echo 120 ;;  F3|f3) echo 99 ;;   F4|f4) echo 118 ;;
    F5|f5) echo 96 ;;   F6|f6) echo 97 ;;   F7|f7) echo 98 ;;   F8|f8) echo 100 ;;
    F9|f9) echo 101 ;;  F10|f10) echo 109 ;; F11|f11) echo 103 ;; F12|f12) echo 111 ;;
    *) echo "" ;;
  esac
}

# AppleScript 字符串字面量转义（\ " 与换行）
as_quote() {
  local s="$1"
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/}
  printf '"%s"' "$s"
}

# 修饰符规范化：cmd/ctrl/shift/option/alt/fn → AppleScript 修饰名
norm_mod() {
  case "$1" in
    cmd|command) echo "command down" ;;
    ctrl|control) echo "control down" ;;
    shift) echo "shift down" ;;
    option|alt) echo "option down" ;;
    fn) echo "fn down" ;;
    *) echo "" ;;
  esac
}

ops=()

# 组合键（整串匹配才成立）：mac 风格 "cmd+s" / "cmd+shift+t"，或 SendKeys 前缀 "^s" "%x" "+a"
mod_names=""
token="$keys"
while true; do
  if [[ "$token" =~ ^(cmd|command|ctrl|control|shift|option|alt|fn)\+(.+)$ ]]; then
    m=$(norm_mod "${BASH_REMATCH[1]}")
    [ -z "$m" ] && break
    mod_names="${mod_names:+$mod_names, }$m"
    token="${BASH_REMATCH[2]}"
    continue
  fi
  # SendKeys 前缀（每个符号一层修饰）
  if [[ "$token" =~ ^(\^|%|\+)(.+)$ ]]; then
    case "${BASH_REMATCH[1]}" in
      "^") m="control down" ;; "%") m="option down" ;; "+") m="shift down" ;;
    esac
    mod_names="${mod_names:+$mod_names, }$m"
    token="${BASH_REMATCH[2]}"
    continue
  fi
  break
done

# SendKeys 特殊键带修饰（如 %{F4}）：剥掉 {TOKEN} 包装，按「特殊键+修饰」处理
# 注意 token 含数字（{F1}..{F12}），字符类必须是 [A-Z0-9]
if [[ "$token" =~ ^\{([A-Z0-9]+)\}$ ]]; then
  token="${BASH_REMATCH[1]}"
fi

if [ "$mod_names" != "" ] && [[ "$token" =~ ^[a-zA-Z0-9]$ ]]; then
  # 单字符 + 修饰：keystroke "s" using {command down}
  ops+=("keystroke $(as_quote "$token") using {$mod_names}")
elif [ "$mod_names" != "" ] && [ -n "$(token_code "$token")" ]; then
  # 特殊键 + 修饰：key code 36 using {command down}
  ops+=("key code $(token_code "$token") using {$mod_names}")
else
  # 文本与 {TOKEN} 混排：逐段切分（{TOKEN} 转 key code，其余整段 keystroke）；
  # 从 $token（已剥修饰前缀）切分，有修饰时逐段附带（SendKeys 语义：^a{DEL} = Ctrl+A 后接退格）
  rest="$token"
  while [[ "$rest" =~ ^([^{]*)\{([A-Z0-9]+)\}(.*)$ ]]; do
    [ -n "${BASH_REMATCH[1]}" ] && ops+=("keystroke $(as_quote "${BASH_REMATCH[1]}")$(if [ -n "$mod_names" ]; then printf ' using {%s}' "$mod_names"; fi)")
    code=$(token_code "${BASH_REMATCH[2]}")
    if [ -n "$code" ]; then
      ops+=("key code $code$(if [ -n "$mod_names" ]; then printf ' using {%s}' "$mod_names"; fi)")
    else
      ops+=("keystroke $(as_quote "{${BASH_REMATCH[2]}}")")
    fi
    rest="${BASH_REMATCH[3]}"
  done
  [ -n "$rest" ] && ops+=("keystroke $(as_quote "$rest")$(if [ -n "$mod_names" ]; then printf ' using {%s}' "$mod_names"; fi)")
fi

if [ ${#ops[@]} -eq 0 ]; then
  echo "没有可发送的按键: $keys" >&2
  exit 2
fi

{
  echo 'tell application "System Events"'
  printf '%s\n' "${ops[@]}"
  echo 'end tell'
} | osascript -

echo "已发送按键: $keys$(if [ -n "$app" ]; then printf ' → %s' "$app"; fi)"
