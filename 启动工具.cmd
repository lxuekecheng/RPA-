@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or later is required. Install it from https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules\exceljs (
  call npm.cmd ci --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node src\server.mjs --open
pause
