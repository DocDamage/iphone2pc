@echo off
setlocal
title PocketDock Development

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install the current LTS release from https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing PocketDock dependencies...
  call npm install
  if errorlevel 1 goto :failed
)

call npm run build:icons
if errorlevel 1 goto :failed
call npm run dev
exit /b %errorlevel%

:failed
echo PocketDock could not start. Review the error above.
pause
exit /b 1
