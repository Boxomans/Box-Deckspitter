@echo off
rem Creates Box-DocSpitter shortcuts on your Desktop and in the Start menu, pointing at this folder.
rem Run it again if you move or copy the folder somewhere else.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dir = (Get-Location).Path;" ^
  "$electron = Join-Path $dir 'node_modules\electron\dist\electron.exe';" ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$targets = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'));" ^
  "foreach ($t in $targets) {" ^
  "  $lnk = $ws.CreateShortcut((Join-Path $t 'Box-DocSpitter.lnk'));" ^
  "  if (Test-Path $electron) {" ^
  "    $lnk.TargetPath = $electron;" ^
  "    $lnk.Arguments = '\"' + (Join-Path $dir 'electron\main.js') + '\"';" ^
  "  } else {" ^
  "    $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe';" ^
  "    $lnk.Arguments = '\"' + (Join-Path $dir 'Box-DocSpitter.vbs') + '\"';" ^
  "  }" ^
  "  $lnk.WorkingDirectory = $dir;" ^
  "  $lnk.IconLocation = (Join-Path $dir 'public\assets\icon.ico') + ',0';" ^
  "  $lnk.Description = 'Box-DocSpitter - local docs, PDFs, text and code';" ^
  "  $lnk.Save();" ^
  "  Write-Host ('Created ' + $lnk.FullName)" ^
  "}"
echo.
echo Done. Look for Box-DocSpitter on your Desktop and in the Start menu.
pause
