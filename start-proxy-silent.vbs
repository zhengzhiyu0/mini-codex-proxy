' 静默启动 mini-codex-proxy：不弹出命令终端窗口，日志写入 logs\proxy-out.log
Option Explicit

Dim fso, shell, projectDir, logDir, logFile, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
logDir = fso.BuildPath(projectDir, "logs")
logFile = fso.BuildPath(logDir, "proxy-out.log")

If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir

' 日志超过约 5MB 时清空，避免无限增长
If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 5242880 Then fso.DeleteFile logFile, True
End If

' cmd 进程本身无窗口，node 作为子进程继承日志文件句柄，因此全程不出现终端窗口
command = "cmd.exe /d /c cd /d """ & projectDir & """ && node.exe proxy.js >> ""logs\proxy-out.log"" 2>&1"
shell.Run command, 0, False
