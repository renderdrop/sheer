# Dev only. Records the real sheer window to an APNG (real frame delays) plus an 8-frame filmstrip PNG.
param([double]$Seconds = 2, [int]$Fps = 15, [Parameter(Mandatory)][string]$Out)
. "$PSScriptRoot/capture.ps1"
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System; using System.IO; using System.Collections.Generic; using System.Drawing; using System.Drawing.Imaging;
public static class SheerApng {
  static uint[] T = Mk();
  static uint[] Mk() { var t = new uint[256]; for (uint n = 0; n < 256; n++) { uint c = n; for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1; t[n] = c; } return t; }
  static uint Crc(byte[] b) { uint c = 0xFFFFFFFFu; foreach (var x in b) c = T[(c ^ x) & 0xFF] ^ (c >> 8); return c ^ 0xFFFFFFFFu; }
  static void BE(Stream s, uint v) { s.WriteByte((byte)(v >> 24)); s.WriteByte((byte)(v >> 16)); s.WriteByte((byte)(v >> 8)); s.WriteByte((byte)v); }
  static void Chunk(Stream s, string type, byte[] data) {
    BE(s, (uint)data.Length); var td = new byte[4 + data.Length];
    for (int i = 0; i < 4; i++) td[i] = (byte)type[i];
    Array.Copy(data, 0, td, 4, data.Length);
    s.Write(td, 0, td.Length); BE(s, Crc(td));
  }
  static byte[] U32(params uint[] v) { var m = new MemoryStream(); foreach (var x in v) BE(m, x); return m.ToArray(); }
  static byte[] Idat(Bitmap bmp) {
    var m = new MemoryStream(); bmp.Save(m, ImageFormat.Png); var b = m.ToArray(); var o = new MemoryStream(); int p = 8;
    while (p < b.Length) {
      uint len = (uint)((b[p] << 24) | (b[p+1] << 16) | (b[p+2] << 8) | b[p+3]);
      string t = System.Text.Encoding.ASCII.GetString(b, p + 4, 4);
      if (t == "IDAT") o.Write(b, p + 8, (int)len);
      p += 12 + (int)len;
    }
    return o.ToArray();
  }
  public static void Write(string path, List<Bitmap> frames, List<int> delaysMs) {
    using (var s = File.Create(path)) {
      s.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }, 0, 8);
      uint w = (uint)frames[0].Width, h = (uint)frames[0].Height;
      var ihdr = new MemoryStream(); BE(ihdr, w); BE(ihdr, h); ihdr.Write(new byte[] { 8, 6, 0, 0, 0 }, 0, 5);
      Chunk(s, "IHDR", ihdr.ToArray()); Chunk(s, "acTL", U32((uint)frames.Count, 0));
      uint seq = 0;
      for (int i = 0; i < frames.Count; i++) {
        var fc = new MemoryStream(); BE(fc, seq++); BE(fc, w); BE(fc, h); BE(fc, 0); BE(fc, 0);
        fc.WriteByte((byte)((delaysMs[i] >> 8) & 255)); fc.WriteByte((byte)(delaysMs[i] & 255));
        fc.WriteByte(0x03); fc.WriteByte(0xE8); fc.WriteByte(0); fc.WriteByte(0);
        Chunk(s, "fcTL", fc.ToArray());
        var id = Idat(frames[i]);
        if (i == 0) Chunk(s, "IDAT", id);
        else { var d = new byte[4 + id.Length]; var sq = U32(seq++); Array.Copy(sq, d, 4); Array.Copy(id, 0, d, 4, id.Length); Chunk(s, "fdAT", d); }
      }
      Chunk(s, "IEND", new byte[0]);
    }
  }
  public static void Strip(string path, List<Bitmap> frames, int n, int tileW) {
    int tileH = frames[0].Height * tileW / frames[0].Width;
    using (var bmp = new Bitmap(tileW * 4, tileH * 2)) using (var g = Graphics.FromImage(bmp)) {
      g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
      for (int i = 0; i < n; i++) {
        int idx = n == 1 ? 0 : i * (frames.Count - 1) / (n - 1);
        g.DrawImage(frames[idx], (i % 4) * tileW, (i / 4) * tileH, tileW, tileH);
      }
      bmp.Save(path, ImageFormat.Png);
    }
  }
}
"@
$h = Get-SheerWindow
$full = [IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Force (Split-Path -Parent $full) | Out-Null
$frames = New-Object 'System.Collections.Generic.List[System.Drawing.Bitmap]'
$stamps = New-Object 'System.Collections.Generic.List[double]'
$sw = [Diagnostics.Stopwatch]::StartNew(); $interval = 1000.0 / $Fps; $next = 0
while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
  $frames.Add([SheerWin]::Grab($h)); $stamps.Add($sw.Elapsed.TotalMilliseconds)
  $next += $interval; $wait = $next - $sw.Elapsed.TotalMilliseconds
  if ($wait -gt 0) { Start-Sleep -Milliseconds ([int]$wait) }
}
$delays = New-Object 'System.Collections.Generic.List[int]'
for ($i = 0; $i -lt $stamps.Count; $i++) {
  $d = if ($i + 1 -lt $stamps.Count) { $stamps[$i + 1] - $stamps[$i] } else { $interval }
  $delays.Add([int][Math]::Max(1, [Math]::Round($d)))
}
[SheerApng]::Write($full, $frames, $delays)
$strip = (Join-Path (Split-Path -Parent $full) ([IO.Path]::GetFileNameWithoutExtension($full))) + '-strip.png'
[SheerApng]::Strip($strip, $frames, [Math]::Min(8, $frames.Count), 480)
("{0} frames, effective {1:N1} fps" -f $frames.Count, ($frames.Count / $sw.Elapsed.TotalSeconds))
Write-Output $full
Write-Output $strip
foreach ($f in $frames) { $f.Dispose() }
