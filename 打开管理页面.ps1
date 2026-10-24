param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$urlFile = Join-Path $PSScriptRoot 'runtime\napcat\console-url.txt'
function Test-CompanionConsole {
    if (-not (Test-Path -LiteralPath $urlFile)) { return $false }
    $savedUrl = (Get-Content -LiteralPath $urlFile -Raw).Trim()
    if ($savedUrl -notmatch '^http://127\.0\.0\.1:\d+/#token=[a-f0-9]+$') { return $false }
    $baseUrl = ([uri]$savedUrl).GetLeftPart([UriPartial]::Authority)
    try {
        $health = Invoke-RestMethod -Uri ($baseUrl + '/health') -TimeoutSec 2
        return ($health.ok -eq $true -and $health.app -eq 'qq-companion')
    } catch { return $false }
}
if (-not (Test-CompanionConsole)) {
    Write-Output '正在启动群友后台，请稍等……'
    & (Join-Path $PSScriptRoot '启动群友.ps1')
    $ready = $false
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        if (Test-CompanionConsole) { $ready = $true; break }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw '管理服务未就绪，请查看文字记录目录中的 server-error.log（默认 F:\botRecord\txt）。' }
}
$consoleUrl = (Get-Content -LiteralPath $urlFile -Raw).Trim()
if ($consoleUrl -notmatch '^http://127\.0\.0\.1:\d+/#token=[a-f0-9]+$') { throw '管理入口格式异常，请重新启动机器人。' }
if ($CheckOnly) { Write-Output '管理入口检查通过，后台已就绪。'; return }
Start-Process -FilePath $consoleUrl
Write-Output '已请求在默认浏览器打开群友管理页面。'
