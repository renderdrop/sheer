# Dev only. Shared helpers: dot-source from shot.ps1 / record.ps1.
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class SheerWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cx, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static Bitmap Grab(IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    var bmp = new Bitmap(r.R - r.L, r.B - r.T, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) { IntPtr dc = g.GetHdc(); PrintWindow(h, dc, 2); g.ReleaseHdc(dc); }
    return bmp;
  }
}
"@
[void][SheerWin]::SetProcessDpiAwarenessContext([IntPtr](-4))
function Get-SheerWindow {
  $p = Get-Process sheer -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $p) { throw 'no sheer window; start scripts/ui/dev.sh' }
  $h = $p.MainWindowHandle
  [void][SheerWin]::ShowWindow($h, 9)
  # Outer size chosen so that the client area is about 1280x800 logical px at the window's DPI.
  $s = [SheerWin]::GetDpiForWindow($h) / 96.0
  [void][SheerWin]::SetWindowPos($h, [IntPtr]::Zero, 40, 40, [int](1296 * $s), [int](839 * $s), 0x0014)
  Start-Sleep -Milliseconds 400
  return $h
}
