@echo off
title Box-DocSpitter
cd /d "%~dp0"
echo Starting Box-DocSpitter. Close the app window to stop it. The server log appears here.
if exist node_modules\electron\dist\electron.exe (
  node_modules\electron\dist\electron.exe electron\main.js %*
  exit /b
)
where node >nul 2>nul || (echo The app files ^(node_modules^) are missing and Node.js isn't installed. Copy the whole folder again. & pause & exit /b 1)
if not exist node_modules (
  echo Installing dependencies, one time...
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)
node server.js --app %*
