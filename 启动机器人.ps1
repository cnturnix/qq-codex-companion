$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$botSettings = @{}
Get-Content -LiteralPath (Join-Path $PSScriptRoot '.env') | ForEach-Object { if ($_ -match '^([^#=]+)=(.*)$') { $botSettings[$matches[1]] = $matches[2] } }
$localPort = if ($botSettings['PORT']) { [int]$botSettings['PORT'] } else { 8787 }
$localBase = 'http://127.0.0.1:' + $localPort
$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
    $nodePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
}
if (-not (Test-Path -LiteralPath $nodePath)) { throw '找不到 Node.js，请安装 Node.js 22 或更新版本。' }
$codexPath = (Get-Command codex -ErrorAction SilentlyContinue).Source
if (-not $codexPath) {
    $codexFolder = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    $codexPath = Get-ChildItem -LiteralPath $codexFolder -Filter 'codex.exe' -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $codexPath) { throw '找不到本机 Codex 程序。' }
$env:CODEX_BIN = $codexPath
$runtimePath = Join-Path $PSScriptRoot 'runtime'
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
$pidFile = Join-Path $runtimePath 'processes.json'
if (Test-Path -LiteralPath $pidFile) {
    $previous = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    if (Get-Process -Id $previous.serverPid -ErrorAction SilentlyContinue) { throw '机器人进程已存在，请先运行停止脚本。' }
}
$server = Start-Process -FilePath $nodePath -ArgumentList @('src/main.mjs') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'server.log') -RedirectStandardError (Join-Path $runtimePath 'server-error.log') -PassThru
$record = @{ serverPid=$server.Id; serverStarted=$server.StartTime.ToUniversalTime().ToString('o'); tunnelPid=$null }
$record | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding utf8
try {
    $ready = $false
    for ($attempt=0; $attempt -lt 20; $attempt++) {
        if ($server.HasExited) { throw '机器人程序启动失败，请查看 runtime\server-error.log。' }
        try { $health = Invoke-RestMethod -Uri ($localBase + '/health') -TimeoutSec 1; if ($health.ok) { $ready=$true; break } } catch { }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw '本机回调服务尚未就绪。' }
    $tunnelExe = Join-Path $PSScriptRoot 'tools\cloudflared.exe'
    if (-not (Test-Path -LiteralPath $tunnelExe)) { throw '尚未下载临时 HTTPS 工具。' }
    if ($botSettings['CODEX_PROXY']) { $env:HTTPS_PROXY = $botSettings['CODEX_PROXY']; $env:HTTP_PROXY = $botSettings['CODEX_PROXY']; $env:NO_PROXY = 'localhost,127.0.0.1,::1' }
    $tunnel = Start-Process -FilePath $tunnelExe -ArgumentList @('tunnel','--no-autoupdate','--protocol','http2','--url',$localBase) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'tunnel.log') -RedirectStandardError (Join-Path $runtimePath 'tunnel-error.log') -PassThru
    $record.tunnelPid = $tunnel.Id
    $record.tunnelStarted = $tunnel.StartTime.ToUniversalTime().ToString('o')
    $record | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding utf8
    Write-Output '服务已在后台启动。临时回调地址生成后会出现在 runtime\tunnel-error.log。'
} catch {
    if (-not $server.HasExited) { Stop-Process -Id $server.Id }
    throw
}
