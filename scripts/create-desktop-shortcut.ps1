# Legt die Desktop-Verknuepfung "Uni-Hotspot" an (nur Benutzer-Desktop, jederzeit durch Loeschen der .lnk rueckgaengig).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'Uni-Hotspot.lnk'
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = Join-Path $root 'scripts\launch-chrome.cmd'
$s.WorkingDirectory = $root
$s.IconLocation = (Join-Path $root 'scripts\hotspot.ico') + ',0'
$s.WindowStyle = 7
$s.Description = 'Uni-Hotspot in Chrome oeffnen'
$s.Save()
Write-Host "Verknuepfung erstellt: $lnk"
