# 启用开机静默自启动：注册计划任务，登录 Windows 后在后台运行代理（无终端窗口）
# 通常由 enable-autostart.cmd 以管理员身份调用，也可在提权的 PowerShell 中直接运行

param([string]$TaskName = 'Mini Codex Proxy')

$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectDir

$vbs = Join-Path $projectDir 'start-proxy-silent.vbs'
if (-not (Test-Path $vbs)) {
  Write-Host "[错误] 未找到 $vbs"
  exit 1
}

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"') -WorkingDirectory $projectDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Write-Host '[成功] 已启用开机自动启动'
Write-Host '       下次开机或重新登录后生效，启动后无终端窗口'
Write-Host '       日志在 logs\proxy-out.log'
