# 重启 mini-codex-proxy：停掉正在监听的旧进程，再用自启动同一条静默路径拉起新进程
# 通常由 restart-proxy.cmd 调用，也可直接运行：powershell -NoProfile -ExecutionPolicy Bypass -File restart-proxy.ps1

$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectDir

# 自启动的计划任务以 -RunLevel Highest 注册，代理进程跑在提权上下文里，
# 未提权的会话对它 Stop-Process 会拿到"拒绝访问"。所以先自提权重跑一次。
$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host '[提权] 需要管理员权限才能停止自启动的代理进程，正在请求…' -ForegroundColor Yellow
  $self = $MyInvocation.MyCommand.Path
  $child = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$self`"" `
    -Verb RunAs -Wait -PassThru
  exit $child.ExitCode
}

# 提权后是一个独立窗口，出错直接退出会让信息随窗口消失，所以失败时停下等一次回车
function Fail($message) {
  Write-Host "[错误] $message" -ForegroundColor Red
  Write-Host ''
  Read-Host '按回车关闭'
  exit 1
}

# 端口来自 config.json，避免脚本里写死一份会和配置漂移的副本
$configPath = Join-Path $projectDir 'config.json'
if (-not (Test-Path $configPath)) {
  Fail "未找到 $configPath"
}
$config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$proxyHost = if ($config.host) { $config.host } else { '127.0.0.1' }
$port = if ($config.port) { [int]$config.port } else { 28080 }

# 按监听端口定位进程，不按进程名——这台机器上还有别的 node.exe 在跑
function Get-ProxyPids {
  @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
}

$pids = Get-ProxyPids
if ($pids.Count -eq 0) {
  Write-Host "[提示] 端口 $port 上没有运行中的代理，直接启动" -ForegroundColor Yellow
} else {
  foreach ($procId in $pids) {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    $name = if ($proc) { $proc.ProcessName } else { '未知进程' }
    Write-Host "[停止] PID $procId ($name) 正在监听 $port"
    try {
      Stop-Process -Id $procId -Force -ErrorAction Stop
    } catch {
      # 静默跳过会让脚本在旧进程还活着时去启动新的，然后撞 EADDRINUSE，
      # 表现成"重启成功但改动没生效"——这里必须报出来。
      Fail "无法结束 PID $procId ：$($_.Exception.Message)"
    }
  }

  # 等端口真正释放：立刻重启会撞上 EADDRINUSE
  $released = $false
  foreach ($i in 1..30) {
    Start-Sleep -Milliseconds 200
    if ((Get-ProxyPids).Count -eq 0) { $released = $true; break }
  }
  if (-not $released) {
    Fail "端口 $port 在 6 秒内未释放，已放弃启动"
  }
}

# 复用自启动计划任务用的同一个 vbs：无终端窗口，日志追加到 logs\proxy-out.log
$vbs = Join-Path $projectDir 'start-proxy-silent.vbs'
if (-not (Test-Path $vbs)) {
  Fail "未找到 $vbs"
}
Write-Host '[启动] 正在后台拉起代理…'
Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`"" -WorkingDirectory $projectDir

# 确认新进程真的起来了，而不是只报告"已启动"
$newPid = $null
foreach ($i in 1..40) {
  Start-Sleep -Milliseconds 250
  $found = Get-ProxyPids
  if ($found.Count -gt 0) { $newPid = $found[0]; break }
}

if (-not $newPid) {
  Fail "代理未在 10 秒内监听 $port，请查看 logs\proxy-out.log"
}

Write-Host "[成功] 代理已重启，PID $newPid" -ForegroundColor Green
Write-Host "       接入地址 http://${proxyHost}:$port"
Write-Host "       监控面板 http://${proxyHost}:$port/_mini"
Write-Host '       日志在 logs\proxy-out.log'
Write-Host ''
# 提权窗口是独立的，不停一下就直接关了，看不到上面这些
Read-Host '按回车关闭'
