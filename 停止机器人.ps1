$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot 'runtime\processes.json'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output '没有已记录的后台进程。'; return }
$record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
foreach ($kind in @('server','tunnel')) {
    $processId = $record."${kind}Pid"
    if (-not $processId) { continue }
    $running = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($running -and $running.StartTime.ToUniversalTime().ToString('o') -eq $record."${kind}Started") {
        # Stop only recorded process trees after verifying the process start time.
        & taskkill.exe /PID $processId /T /F | Out-Null
    }
}
Write-Output '机器人和临时公网连接已停止。'
