@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title Uni-Hotspot

rem ---------------------------------------------------------------------
rem  Uni-Hotspot starten (ohne Admin-Rechte).
rem    start.bat           -> Desktop-App (Electron)
rem    start.bat browser   -> nur lokaler Server + Standardbrowser
rem  Alle Caches bleiben im Projektordner (.cache), Nutzerdaten im Datenordner.
rem ---------------------------------------------------------------------

set "npm_config_cache=%~dp0.cache\npm"
set "electron_config_cache=%~dp0.cache\electron"
set "NODE_COMPILE_CACHE=%~dp0.cache\node-compile"
set "npm_config_update_notifier=false"
set "npm_config_fund=false"
set "npm_config_audit=false"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js wurde nicht gefunden.
  echo   Bitte Node.js 24 LTS installieren: https://nodejs.org/
  echo   Ohne Admin: "Windows Binary (.zip)" herunterladen, z. B. nach %%USERPROFILE%%\node entpacken
  echo   und diesen Ordner zur PATH-Variable des Benutzers hinzufuegen.
  echo.
  pause
  exit /b 1
)

node scripts\check-node.mjs
if errorlevel 1 (
  pause
  exit /b 1
)

rem Abhaengigkeiten nur (neu) installieren, wenn package-lock.json sich geaendert hat (z. B. nach einem Update)
node scripts\check-deps.mjs
if errorlevel 1 (
  echo.
  echo   Abhaengigkeiten werden installiert/aktualisiert ^(ca. 1-3 Minuten^) ...
  echo.
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   npm ci ist fehlgeschlagen - Details siehe oben.
    pause
    exit /b 1
  )
  node scripts\check-deps.mjs --write
)

set "MODE=--desktop"
if /i "%~1"=="browser" set "MODE=--browser --open"

node scripts\start.mjs %MODE%
if errorlevel 1 pause
endlocal
