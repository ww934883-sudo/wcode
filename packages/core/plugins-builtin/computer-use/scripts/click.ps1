# 鼠标点击（Windows）：移动到物理像素坐标并点击。
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File click.ps1 -X 520 -Y 300 [-Double] [-Right]
param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [switch]$Double,
  [switch]$Right
)
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class Mouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, System.UIntPtr dwExtraInfo);
}
"@
# 与 screenshot.ps1 同为物理像素坐标系（缩放屏一致）
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class DpiHelper {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[DpiHelper]::SetProcessDPIAware() | Out-Null
[DpiHelper]::SetProcessDPIAware() | Out-Null

$LEFT_DOWN = 0x02; $LEFT_UP = 0x04
$RIGHT_DOWN = 0x08; $RIGHT_UP = 0x10

[Mouse]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 80

function Click-Once([uint32]$down, [uint32]$up) {
  [Mouse]::mouse_event($down, 0, 0, 0, [System.UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [Mouse]::mouse_event($up, 0, 0, 0, [System.UIntPtr]::Zero)
}

if ($Right) { Click-Once $RIGHT_DOWN $RIGHT_UP }
else { Click-Once $LEFT_DOWN $LEFT_UP }
if ($Double) {
  Start-Sleep -Milliseconds 90
  if ($Right) { Click-Once $RIGHT_DOWN $RIGHT_UP }
  else { Click-Once $LEFT_DOWN $LEFT_UP }
}
Write-Output "已在 ($X, $Y) $(if ($Double) { '双击' } elseif ($Right) { '右键' } else { '单击' })"
