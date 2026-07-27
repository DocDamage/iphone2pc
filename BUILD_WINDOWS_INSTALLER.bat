@echo off
setlocal
title PocketDock Windows Builder

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install the current LTS release from https://nodejs.org/
  pause
  exit /b 1
)

echo.
echo [1/4] Installing PocketDock dependencies...
call npm install
if errorlevel 1 goto :failed

echo.
echo [2/4] Generating application icons...
call npm run build:icons
if errorlevel 1 goto :failed

echo.
echo [3/4] Running automated verification...
call npm run verify
if errorlevel 1 goto :failed

echo.
echo [4/4] Building the Windows installer...
call npm run package:win
if errorlevel 1 goto :failed

echo.
echo PocketDock is ready. Open the release folder to find the installer.
start "" "%~dp0release"
pause
exit /b 0

:failed
echo.
echo The build stopped because one of the checks failed.
echo Review the error shown above before trying again.
pause
exit /b 1
