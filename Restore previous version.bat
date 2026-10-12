@echo off
rem Puts back the Box-DocSpitter version from before the last update. Needs nothing but Windows itself, so it
rem works even if the app can't start. Your files (data, dumps) are never touched.
title Box-DocSpitter - restore previous version
cd /d "%~dp0"
set "BK="
for /f "delims=" %%d in ('dir /b /ad /o-d "data\backups\app" 2^>nul') do if not defined BK set "BK=data\backups\app\%%d"
if not defined BK (
  echo There is no earlier version saved, so there is nothing to restore.
  pause
  exit /b 1
)
echo This puts back the version saved in:
echo   %BK%
echo Close Box-DocSpitter first.
choice /m "Restore it now"
if errorlevel 2 exit /b 0
robocopy "%BK%\files" "%~dp0." /E /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo Copying the saved files failed. Nothing else was changed.
  pause
  exit /b 1
)
if exist "%BK%\added.txt" for /f "usebackq delims=" %%f in ("%BK%\added.txt") do if exist "%%f" del /q "%%f"
del /q "data\update\trial.json" "data\update\pending.json" >nul 2>nul
rd /s /q "%BK%"
echo Done. Start Box-DocSpitter again.
pause
