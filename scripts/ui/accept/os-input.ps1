# Real OS input for the smoke test only (ADR-131). Targets the acceptance process's main window and refuses any other.
# -Action click -Fx 0.5 -Fy 0.5 : left click at a fraction of the window rect
# -Action clickclient -Cx 120 -Cy 300 -Scale 1.25 : left click at CSS px of the webview (client area) times devicePixelRatio
# -Action key -Keys '^o'        : SendKeys string, only after the window is verified foreground
param([int]$ProcId, [string]$Action, [double]$Fx = 0.5, [double]$Fy = 0.5, [string]$Keys = '', [double]$Cx = 0, [double]$Cy = 0, [double]$Scale = 1)
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class O {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref P p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
}
"@
[void][O]::SetProcessDPIAware()
$p = Get-Process -Id $ProcId -ErrorAction Stop
if ($p.ProcessName -ne 'sheer-acceptance') { throw "refusing: pid $ProcId is '$($p.ProcessName)', not sheer-acceptance" }
$h = $p.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { throw 'no main window' }
# Windows only lets the process that got the last input move a window to the front: a bare Shift tap grants it (Alt would
# focus the app's menu row).
[O]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero); [O]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero)
[void][O]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 200
if ([O]::GetForegroundWindow() -ne $h) { throw 'acceptance window is not foreground; not sending input' }
if ($Action -eq 'click') {
  $r = New-Object O+R
  [void][O]::GetWindowRect($h, [ref]$r)
  $x = [int]($r.L + ($r.Rt - $r.L) * $Fx); $y = [int]($r.T + ($r.B - $r.T) * $Fy)
  [void][O]::SetCursorPos($x, $y)
  [O]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero); [O]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
} elseif ($Action -eq 'clickclient') {
  $pt = New-Object O+P; $pt.X = [int]($Cx * $Scale); $pt.Y = [int]($Cy * $Scale)
  [void][O]::ClientToScreen($h, [ref]$pt)
  [void][O]::SetCursorPos($pt.X, $pt.Y)
  Start-Sleep -Milliseconds 150
  [O]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero); [O]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
} elseif ($Action -eq 'key') {
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
} else { throw "unknown action $Action" }
