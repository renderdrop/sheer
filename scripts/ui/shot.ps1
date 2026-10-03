# Dev only. Screenshot of the real sheer window (PrintWindow, PW_RENDERFULLCONTENT).
param([Parameter(Mandatory)][string]$Out)
. "$PSScriptRoot/capture.ps1"
$h = Get-SheerWindow
$full = [IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Force (Split-Path -Parent $full) | Out-Null
$bmp = [SheerWin]::Grab($h)
$bmp.Save($full, [Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output $full
