@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 20 or newer from https://nodejs.org first.
  pause
  exit /b 1
)
echo Open the address printed below in your browser.
node server.mjs
pause
