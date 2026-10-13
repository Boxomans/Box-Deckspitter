@echo off
title Box-DocSpitter
cd /d "%~dp0"
echo Starting Box-DocSpitter. Close the app window to stop it. The server log appears here.
if exist node_modules\electron\dist\electron.exe (
  node_modules\electron\dist\electron.exe electron\main.js %*
  exit /b
)
where node >nul 2>nul && goto :havenode
echo.
echo The app files ^(node_modules^) are missing. They're downloaded once with Node.js, which isn't installed.
echo ^(Or copy the whole folder again, including node_modules: then nothing needs installing.^)
where winget >nul 2>nul || (echo Install Node.js ^(the LTS version^) from https://nodejs.org and run this again. & pause & exit /b 1)
echo.
choice /c YN /m "Install Node.js now with winget (winget install OpenJS.NodeJS.LTS)"
if errorlevel 2 exit /b 1
winget install --id OpenJS.NodeJS.LTS --exact --source winget || (echo Node.js didn't install. & pause & exit /b 1)
rem the installer adds Node.js to the PATH for new windows only: use it from where it went
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
where node >nul 2>nul || (echo Node.js is installed but not available yet. Open this again ^(or restart the PC first^). & pause & exit /b 1)
:havenode
if not exist node_modules (
  echo Installing dependencies, one time...
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)
if exist node_modules\electron\dist\electron.exe (
  node_modules\electron\dist\electron.exe electron\main.js %*
  exit /b
)
node server.js --app %*
