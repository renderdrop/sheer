# Native window move/resize for acceptance (ADR-145). Targets the acceptance process's main window only and sends no input.
# -Action rect                              : prints the window rect as JSON
# -Action bounds -X 40 -Y 40 -W 1280 -H 800 : moves and sizes the window (physical px)
# -Action move -Dx 12 -Dy 6 -Steps 20       : moves the window step by step (16 ms apart), like a drag
param([int]$ProcId, [string]$Action, [int]$X = 0, [int]$Y = 0, [int]$W = 0, [int]$H = 0, [int]$Dx = 0, [int]$Dy = 0, [int]$Steps = 1)
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Wn {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
}
"@
[void][Wn]::SetProcessDPIAware()
$p = Get-Process -Id $ProcId -ErrorAction Stop
if ($p.ProcessName -ne 'sheer-acceptance') { throw "refusing: pid $ProcId is '$($p.ProcessName)', not sheer-acceptance" }
$hwnd = $p.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { throw 'no main window' }
$r = New-Object Wn+R; [void][Wn]::GetWindowRect($hwnd, [ref]$r)
$flags = 0x0004 -bor 0x0010 # SWP_NOZORDER | SWP_NOACTIVATE
if ($Action -eq 'bounds') {
  if (-not [Wn]::SetWindowPos($hwnd, [IntPtr]::Zero, $X, $Y, $W, $H, $flags)) { throw 'SetWindowPos failed' }
} elseif ($Action -eq 'move') {
  for ($i = 1; $i -le $Steps; $i++) {
    [void][Wn]::SetWindowPos($hwnd, [IntPtr]::Zero, $r.L + $Dx * $i, $r.T + $Dy * $i, 0, 0, $flags -bor 0x0001) # SWP_NOSIZE
    Start-Sleep -Milliseconds 16
  }
} elseif ($Action -ne 'rect') { throw "unknown action '$Action'" }
[void][Wn]::GetWindowRect($hwnd, [ref]$r)
"{`"x`":$($r.L),`"y`":$($r.T),`"w`":$($r.Rt - $r.L),`"h`":$($r.B - $r.T)}"
