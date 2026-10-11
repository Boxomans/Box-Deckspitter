' Box-DocSpitter setup/fallback launcher. Normally you start the app with Box-DocSpitter.exe; this script is
' what that falls back to when the app window runtime (node_modules) is missing, and it can set it up.
' Drag files onto this (or its shortcut) to open them.
Option Explicit
Dim sh, fso, dir, args, i, electron, hasNode
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
electron = dir & "\node_modules\electron\dist\electron.exe"

args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " """ & WScript.Arguments(i) & """"
Next
sh.CurrentDirectory = dir

' Portable path: Electron brings its own Node, so nothing needs to be installed.
If fso.FileExists(electron) Then
  sh.Run """" & electron & """ """ & dir & "\electron\main.js""" & args, 1, False
  WScript.Quit 0
End If

' Setup path: node_modules is missing or incomplete, so it needs Node.js and internet once.
hasNode = (sh.Run("cmd /c where node >nul 2>nul", 0, True) = 0)
If Not hasNode Then
  MsgBox "Box-DocSpitter's app files (the node_modules folder) are missing." & vbCrLf & vbCrLf & _
         "Either copy the whole Box-DocSpitter folder again including node_modules, or install Node.js once" & vbCrLf & _
         "(winget install OpenJS.NodeJS.LTS) and start Box-DocSpitter again to download them.", vbExclamation, "Box-DocSpitter"
  WScript.Quit 1
End If

If Not fso.FolderExists(dir & "\node_modules") Then
  sh.Run "cmd /c title Box-DocSpitter setup && cd /d """ & dir & """ && echo Installing Box-DocSpitter (one time)... && npm install --no-audit --no-fund && echo Done. && timeout /t 3", 1, True
End If
If Not fso.FileExists(electron) And fso.FileExists(dir & "\node_modules\electron\install.js") Then
  ' npm sometimes skips Electron's download step; fetch the app window runtime once.
  sh.Run "cmd /c title Box-DocSpitter setup && cd /d """ & dir & """ && echo Downloading the app window (one time)... && node node_modules\electron\install.js", 1, True
End If

If fso.FileExists(electron) Then
  sh.Run """" & electron & """ """ & dir & "\electron\main.js""" & args, 1, False
Else
  ' Last resort: browser app window.
  sh.Run "node """ & dir & "\server.js"" --app" & args, 0, False
End If
