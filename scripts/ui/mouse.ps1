# Dev only. Real OS mouse input on the sheer window (SetCursorPos + SendInput), for acceptance "by mouse" (FEEDBACK F11).
# Points are CSS px relative to the webview's client area (what getBoundingClientRect returns at zoom 1); the DPI scale is applied here.
# Usage: mouse.ps1 -Click "x,y" | -Drag "x1,y1;x2,y2;..." [-Steps 12] [-HoldShot review/mid.png] [-Double]
param([string]$Click, [string]$Drag, [int]$Steps = 12, [string]$HoldShot, [int]$HoldMs = 0, [switch]$Double, [string]$Exe = 'sheer')
. "$PSScriptRoot/capture.ps1"
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class SheerMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@
$p = Get-Process $Exe -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { throw "no $Exe window" }
$h = $p.MainWindowHandle
[void][SheerMouse]::SetForegroundWindow($h)
$s = [SheerWin]::GetDpiForWindow($h) / 96.0
function To-Screen([string]$xy) {
  $a = $xy.Split(',') | ForEach-Object { [double]$_ }
  $pt = New-Object SheerMouse+POINT; $pt.X = [int]($a[0] * $s); $pt.Y = [int]($a[1] * $s)
  [void][SheerMouse]::ClientToScreen($h, [ref]$pt); return $pt
}
function Step-Cursor($pt) { [void][SheerMouse]::SetCursorPos($pt.X, $pt.Y); Start-Sleep -Milliseconds 16 }
if ($Click) {
  $pt = To-Screen $Click; Step-Cursor $pt
  $n = if ($Double) { 2 } else { 1 }
  for ($i = 0; $i -lt $n; $i++) { [SheerMouse]::mouse_event(2, 0, 0, 0, 0); [SheerMouse]::mouse_event(4, 0, 0, 0, 0); Start-Sleep -Milliseconds 60 }
}
if ($Drag) {
  $pts = $Drag.Split(';') | ForEach-Object { To-Screen $_ }
  Step-Cursor $pts[0]; [SheerMouse]::mouse_event(2, 0, 0, 0, 0); Start-Sleep -Milliseconds 40
  for ($k = 1; $k -lt $pts.Count; $k++) {
    $a = $pts[$k - 1]; $b = $pts[$k]
    for ($i = 1; $i -le $Steps; $i++) {
      $q = New-Object SheerMouse+POINT; $q.X = [int]($a.X + ($b.X - $a.X) * $i / $Steps); $q.Y = [int]($a.Y + ($b.Y - $a.Y) * $i / $Steps); Step-Cursor $q
    }
  }
  if ($HoldShot) {
    Start-Sleep -Milliseconds 150
    $full = [IO.Path]::GetFullPath($HoldShot); New-Item -ItemType Directory -Force (Split-Path -Parent $full) | Out-Null
    $bmp = [SheerWin]::Grab($h); $bmp.Save($full, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); Write-Output $full
  }
  if ($HoldMs -gt 0) { Start-Sleep -Milliseconds $HoldMs }
  [SheerMouse]::mouse_event(4, 0, 0, 0, 0)
}
