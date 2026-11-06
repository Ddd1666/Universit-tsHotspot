@echo off
rem Erstellt die Desktop-Verknuepfung "Uni-Hotspot" (Doppelklick genuegt, kein Admin).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\create-desktop-shortcut.ps1"
pause
