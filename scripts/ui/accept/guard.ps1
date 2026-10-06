# Dialog guard probe (ADR-131). Prints one JSON line per interval: foreground window + visible top-level windows of the given pids.
# Never clicks. With -Esc <hwnd> it posts a single Escape key to that window and exits.
param([int[]]$Pids = @(), [long]$Esc = 0, [int]$IntervalMs = 250)
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class G {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  static string Q(string s) { return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ") + "\""; }
  public static string Info(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    var t = new StringBuilder(256); var c = new StringBuilder(256);
    GetWindowText(h, t, 256); GetClassName(h, c, 256);
    return "{\"hwnd\":" + h.ToInt64() + ",\"pid\":" + pid + ",\"visible\":" + (IsWindowVisible(h) ? "true" : "false") +
      ",\"title\":" + Q(t.ToString()) + ",\"class\":" + Q(c.ToString()) + "}";
  }
  public static string Snapshot(uint[] pids) {
    var list = new List<string>();
    var set = new HashSet<uint>(pids);
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (set.Contains(p)) list.Add(Info(h)); return true; }, IntPtr.Zero);
    var fg = GetForegroundWindow();
    return "{\"foreground\":" + (fg == IntPtr.Zero ? "null" : Info(fg)) + ",\"windows\":[" + string.Join(",", list) + "]}";
  }
}
"@
if ($Esc -ne 0) {
  [void][G]::PostMessage([IntPtr]$Esc, 0x100, [IntPtr]27, [IntPtr]0)
  [void][G]::PostMessage([IntPtr]$Esc, 0x101, [IntPtr]27, [IntPtr]0)
  exit 0
}
$u = [uint32[]]($Pids | ForEach-Object { [uint32]$_ })
while ($true) {
  [Console]::Out.WriteLine([G]::Snapshot($u)); [Console]::Out.Flush()
  Start-Sleep -Milliseconds $IntervalMs
}
