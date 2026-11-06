# Legt die Verknuepfung "Uni-Hotspot.lnk" auf dem Desktop des angemeldeten Benutzers an (kein Admin, keine Registry).
# Rueckgaengig: die Verknuepfung loeschen. Erneut ausfuehren ueberschreibt sie (z. B. nach Verschieben des Projektordners).
# Zielordner fuer Tests: Parameter -TargetDir oder Umgebungsvariable HOTSPOT_SHORTCUT_DIR.
param([string]$TargetDir = $env:HOTSPOT_SHORTCUT_DIR)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not $TargetDir) { $TargetDir = [Environment]::GetFolderPath('Desktop') }
if (-not $TargetDir -or -not (Test-Path -LiteralPath $TargetDir -PathType Container)) {
  throw "Desktop-Ordner nicht gefunden: '$TargetDir'"
}

$lnk = Join-Path $TargetDir 'Uni-Hotspot.lnk'
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = Join-Path $root 'scripts\launch-hotspot.cmd'
$s.Arguments = ''
$s.WorkingDirectory = $root
$s.IconLocation = (Join-Path $root 'scripts\hotspot.ico') + ',0'
$s.WindowStyle = 7
$s.Description = 'Uni-Hotspot in Chrome oeffnen (startet den lokalen Server bei Bedarf)'
$s.Save()

Write-Host ''
Write-Host "  Verknuepfung erstellt: $lnk"
Write-Host '  Doppelklick darauf oeffnet Uni-Hotspot in Chrome.'
Write-Host '  Entfernen: die Verknuepfung "Uni-Hotspot" auf dem Desktop loeschen.'
Write-Host ''
