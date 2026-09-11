# 取消开机静默自启动：删除计划任务
# 通常由 disable-autostart.cmd 以管理员身份调用，也可在提权的 PowerShell 中直接运行

param([string]$TaskName = 'Mini Codex Proxy')

$ErrorActionPreference = 'Stop'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host '[提示] 未找到计划任务，无需取消'
  exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

Write-Host '[成功] 已取消开机自动启动'
Write-Host '       注意：当前正在运行的代理进程不会自动停止'
Write-Host '       如需立即停止，打开任务管理器结束所有 node.exe 进程'
