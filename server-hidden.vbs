' ABS90 server launcher - runs python http.server with NO console window.
' Serves this script's own folder on 127.0.0.1:8792 (exposed via Cloudflare Tunnel abs.get1004.com).
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = scriptDir
' 0 = hidden window, False = don't wait
sh.Run "python -m http.server 8792 --bind 127.0.0.1", 0, False
