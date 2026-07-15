' ABS90 local development launcher - runs Wrangler with no console window.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = scriptDir
' 0 = hidden window, False = don't wait
sh.Run "cmd /c npm run dev", 0, False
