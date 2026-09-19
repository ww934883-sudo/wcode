# 键盘输入（Windows）：WScript.Shell.SendKeys。
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File keys.ps1 -Keys "hello{ENTER}" [-AppTitle "记事本"]
param(
  [Parameter(Mandatory = $true)][string]$Keys,
  [string]$AppTitle
)
$ErrorActionPreference = "Stop"

$ws = New-Object -ComObject WScript.Shell
if ($AppTitle) {
  # AppActivate 按窗口标题前缀/精确名或进程 id 匹配；失败时给出可行动错误
  $activated = $ws.AppActivate($AppTitle)
  if (-not $activated) {
    Write-Error "未找到标题为「$AppTitle」的窗口。用 Get-Process | Where-Object { `$_.MainWindowTitle } 查看现有窗口标题后重试"
    exit 1
  }
  Start-Sleep -Milliseconds 300
}
$ws.SendKeys($Keys)
Write-Output "已发送按键: $Keys$(if ($AppTitle) { " → $AppTitle" })"
