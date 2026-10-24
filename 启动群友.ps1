$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) { $nodePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $nodePath)) { throw '找不到 Node.js，请安装 Node.js 24.5 或更新版本。' }
$codexPath = (Get-Command codex -ErrorAction SilentlyContinue).Source
if (-not $codexPath) {
    $codexFolder = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    $codexPath = Get-ChildItem -LiteralPath $codexFolder -Filter 'codex.exe' -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $codexPath) { throw '找不到本机 Codex 程序。' }
$env:CODEX_BIN = $codexPath
$runtimePath = Join-Path $PSScriptRoot 'runtime\napcat'
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
$pidFile = Join-Path $runtimePath 'process.json'
if (Test-Path -LiteralPath $pidFile) {
    $previous = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $running = Get-Process -Id $previous.pid -ErrorAction SilentlyContinue
    if ($running -and -not $running.HasExited -and $running.StartTime.ToUniversalTime().Ticks -eq ([datetime]$previous.started).ToUniversalTime().Ticks) { Write-Output '群友机器人已经在运行。运行“打开管理页面.ps1”进入管理。'; return }
}
$recordLogPath = (& $nodePath (Join-Path $PSScriptRoot 'src\record-path.mjs')).Trim()
if ($LASTEXITCODE -ne 0 -or -not $recordLogPath) { throw '无法确定文字记录目录。' }
New-Item -ItemType Directory -Force -Path $recordLogPath | Out-Null
$server = Start-Process -FilePath $nodePath -ArgumentList @('src/napcat-main.mjs') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $recordLogPath 'server.log') -RedirectStandardError (Join-Path $recordLogPath 'server-error.log') -PassThru
@{ pid=$server.Id; started=$server.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding utf8
Start-Sleep -Milliseconds 1000
if ($server.HasExited) {
    Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
    throw ('启动失败，请查看 ' + (Join-Path $recordLogPath 'server-error.log'))
}
Write-Output '群友机器人已在后台启动。请运行“打开管理页面.ps1”，设置允许的群和人设。'
Write-Output 'NapCat 请单独启动并扫码登录。无需 QQ 官方应用凭证或公网回调地址。'
