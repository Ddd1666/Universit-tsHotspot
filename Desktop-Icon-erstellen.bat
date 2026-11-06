@echo off
rem Legt die Desktop-Verknuepfung "Uni-Hotspot" an (Doppelklick genuegt, kein Admin).
rem Rueckgaengig: die Verknuepfung auf dem Desktop loeschen.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\create-desktop-shortcut.ps1"
if errorlevel 1 (
  echo.
  echo   Verknuepfung konnte nicht erstellt werden - Meldung siehe oben.
)
pause
