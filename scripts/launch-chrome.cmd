@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
title Uni-Hotspot

rem Startet den Uni-Hotspot-Server (falls er nicht laeuft) und oeffnet ihn in Chrome.
rem Kein Admin noetig. Server-Fenster (minimiert) bleibt offen, solange Uni-Hotspot laeuft.
if "%HOTSPOT_PORT%"=="" (set "PORT=4317") else (set "PORT=%HOTSPOT_PORT%")
set "URL=http://127.0.0.1:%PORT%"

call :check
if not errorlevel 1 goto open

echo Starte Uni-Hotspot ... (beim allerersten Start dauert die Installation 1-3 Minuten)
start "Uni-Hotspot Server (nicht schliessen)" /min cmd /c ""%CD%\start.bat" server"
set /a N=0
:wait
timeout /t 1 /nobreak >nul
call :check
if not errorlevel 1 goto open
set /a N+=1
if %N% LSS 300 goto wait
echo.
echo Uni-Hotspot antwortet nicht. Bitte "start-browser.bat" doppelklicken und die Meldungen lesen.
pause
exit /b 1

:open
set "CHROME="
for %%P in ("%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%LocalAppData%\Google\Chrome\Application\chrome.exe") do if exist %%P if not defined CHROME set "CHROME=%%~P"
if defined CHROME (
  start "" "%CHROME%" --app=%URL%
) else (
  start "" %URL%
)
exit /b 0

:check
curl.exe -s -o nul -m 2 -w "%%{http_code}" %URL%/api/health 2>nul | findstr /x "401" >nul
exit /b
