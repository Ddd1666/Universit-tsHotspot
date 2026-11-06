@echo off
setlocal EnableExtensions
rem Ziel der Desktop-Verknuepfung "Uni-Hotspot": oeffnet Uni-Hotspot in Chrome (App-Fenster) und
rem startet vorher den Server, falls er nicht laeuft. Die Logik steht in launch-hotspot.mjs.
cd /d "%~dp0.."
title Uni-Hotspot (Start)

where node >nul 2>nul && node scripts\check-node.mjs >nul 2>nul
if errorlevel 1 (
  rem Node fehlt oder ist zu alt: start.bat zeigt die Anleitung in einem normalen Fenster
  start "Uni-Hotspot" cmd /c ""%~dp0..\start.bat" server"
  exit /b 1
)

node scripts\launch-hotspot.mjs
exit /b %errorlevel%
