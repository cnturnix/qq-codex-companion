$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot 'runtime\napcat\process.json'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output '没有已记录的群友机器人进程。'; return }
$record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$running = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if ($running -and -not $running.HasExited -and $running.StartTime.ToUniversalTime().Ticks -eq ([datetime]$record.started).ToUniversalTime().Ticks) {
    & taskkill.exe /PID $record.pid /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '进程未能停止，请检查当前用户的进程管理权限。' }
    Wait-Process -Id $record.pid -Timeout 10 -ErrorAction SilentlyContinue
    $remaining = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if ($remaining -and -not $remaining.HasExited) { throw '进程仍在退出，请稍后再试。' }
    $lockFile = Join-Path $PSScriptRoot 'runtime\napcat\instance.lock'
    if ((Test-Path -LiteralPath $lockFile) -and [IO.File]::ReadAllText($lockFile).Trim() -eq [string]$record.pid) { Remove-Item -LiteralPath $lockFile }
}
Write-Output '群友机器人已停止。NapCat 和 QQ 小号保持原状态。'
