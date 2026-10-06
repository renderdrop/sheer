# Real OS input for the smoke test only (ADR-131). Targets the acceptance process's main window and refuses any other.
# -Action click -Fx 0.5 -Fy 0.5 : left click at a fraction of the window rect
# -Action key -Keys '^o'        : SendKeys string, only after the window is verified foreground
param([int]$ProcId, [string]$Action, [double]$Fx = 0.5, [double]$Fy = 0.5, [string]$Keys = '')
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
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
"@
[void][O]::SetProcessDPIAware()
$p = Get-Process -Id $ProcId -ErrorAction Stop
if ($p.ProcessName -ne 'sheer-acceptance') { throw "refusing: pid $ProcId is '$($p.ProcessName)', not sheer-acceptance" }
$h = $p.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { throw 'no main window' }
[void][O]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 200
if ([O]::GetForegroundWindow() -ne $h) { throw 'acceptance window is not foreground; not sending input' }
if ($Action -eq 'click') {
  $r = New-Object O+R
  [void][O]::GetWindowRect($h, [ref]$r)
  $x = [int]($r.L + ($r.Rt - $r.L) * $Fx); $y = [int]($r.T + ($r.B - $r.T) * $Fy)
  [void][O]::SetCursorPos($x, $y)
  [O]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero); [O]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
} elseif ($Action -eq 'key') {
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
} else { throw "unknown action $Action" }
