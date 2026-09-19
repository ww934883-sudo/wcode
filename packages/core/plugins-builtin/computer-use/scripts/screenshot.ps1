# 屏幕截图（Windows）：全屏或区域，保存为 PNG。
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File screenshot.ps1 -Out shot.png [-X 0 -Y 0 -W 800 -H 600]
param(
  [string]$Out = "screenshot.png",
  [int]$X = -1,
  [int]$Y = -1,
  [int]$W = -1,
  [int]$H = -1
)
$ErrorActionPreference = "Stop"

# DPI 感知：缩放屏（125%/150%）下 CopyFromScreen 需要物理像素坐标
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class DpiHelper {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[DpiHelper]::SetProcessDPIAware() | Out-Null

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
if ($X -lt 0) { $X = 0 }
if ($Y -lt 0) { $Y = 0 }
if ($W -le 0) { $W = $bounds.Width }
if ($H -le 0) { $H = $bounds.Height }
if ($X + $W -gt $bounds.Width) { $W = $bounds.Width - $X }
if ($Y + $H -gt $bounds.Height) { $H = $bounds.Height - $Y }
if ($W -le 0 -or $H -le 0) {
  Write-Error "截图区域越界（屏幕 $($bounds.Width)x$($bounds.Height)）"
  exit 1
}

$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)))
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "已保存: $((Resolve-Path $Out).Path)（${W}x${H}）"
