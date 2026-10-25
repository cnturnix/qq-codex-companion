param(
    [string]$Message = '',
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

function Invoke-ProjectGit {
    & git -c core.quotepath=false @args
    if ($LASTEXITCODE -ne 0) { throw 'Git 操作未完成，请查看上方提示。' }
}

function Test-SourcePath([string]$Path) {
    # Only project source and documentation belong in this public repository.
    if ($Path -match '(^|/)(runtime|work|tools|node_modules|records|botRecord|backups|logs|bootmain|\.codex|\.agents|\.aws|\.ssh|NapCat[^/]*)(/|$)') { return $false }
    if ($Path -match '(^|/)(console-token|console-url\.txt|settings\.json|companion\.json|media-library\.json)$') { return $false }
    if ($Path -match '(^|/)\.env($|\.)' -and $Path -ne '.env.example') { return $false }
    if ($Path -match '^(src|ui|test|docs)/' -and $Path -match '\.(mjs|js|ts|html|css|md|json|yaml|yml)$') { return $true }
    return $Path -in @(
        '.gitignore', '.gitattributes', '.env.example', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
        'README.md', 'GPT_Companion_Codex_Implementation_Spec.md',
        '方向文档.md', '历史决策.md', '执行蓝图.md', '使用说明.md', '群友使用说明.md',
        '启动机器人.ps1', '停止机器人.ps1', '启动群友.ps1', '停止群友.ps1', '打开管理页面.ps1',
        '打开群友管理.cmd', '启动群友机器人.cmd', '停止群友机器人.cmd', '同步GitHub.ps1', '同步GitHub.cmd'
    )
}

try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw '找不到 Git，请先安装 Git for Windows。' }
    $repoRoot = (Invoke-ProjectGit rev-parse --show-toplevel).Trim()
    if ([IO.Path]::GetFullPath($repoRoot) -ne [IO.Path]::GetFullPath($PSScriptRoot)) { throw '请把此工具放在项目 Git 仓库根目录。' }
    $branch = (Invoke-ProjectGit branch --show-current).Trim()
    if (-not $branch) { throw '当前没有选中的分支，请先切换到要上传的分支。' }
    $remote = (Invoke-ProjectGit remote get-url --push origin).Trim()
    if ($remote -match '^https?://[^/]*@') { throw '远程地址含登录信息，请改用不带密码或 Token 的地址和 Git 登录管理器。' }
    Write-Host ('上传目标：' + $remote + '  分支：' + $branch)

    $staged = @(Invoke-ProjectGit diff --cached --name-only)
    foreach ($path in $staged) {
        if (-not (Test-SourcePath $path)) { throw ('暂存区包含发布范围外的文件，请先移出暂存区：' + $path) }
    }
    $candidates = @(Invoke-ProjectGit ls-files --cached --others --exclude-standard | Sort-Object -Unique | Where-Object { Test-SourcePath $_ })
    if ($candidates.Count -eq 0) { throw '没有找到可同步的项目源码或说明文件。' }
    if ($Check) {
        Write-Host '只检查待同步文件；不暂存、不提交、不上传。'
        Invoke-ProjectGit status --short -- $candidates
        exit 0
    }

    Invoke-ProjectGit add --all -- $candidates
    & git diff --cached --quiet
    $diffCode = $LASTEXITCODE
    if ($diffCode -gt 1) { throw '无法检查暂存区。' }
    if ($diffCode -eq 1) {
        Invoke-ProjectGit diff --cached --stat
        if (-not $Message.Trim()) { $Message = Read-Host '写一句本次更新说明（直接回车使用默认说明）' }
        if (-not $Message.Trim()) { $Message = '更新项目 ' + (Get-Date -Format 'yyyy-MM-dd HH:mm') }
        Invoke-ProjectGit commit -m $Message
    } else { Write-Host '没有新的源码修改，将检查并上传已有的本地提交。' }

    # Reuse only an explicitly configured local proxy, without changing Git settings.
    $networkArgs = @('-c', 'http.lowSpeedLimit=100', '-c', 'http.lowSpeedTime=30')
    $envFile = Join-Path $PSScriptRoot '.env'
    if (Test-Path -LiteralPath $envFile) {
        foreach ($line in [IO.File]::ReadAllLines($envFile)) {
            if ($line -match '^CODEX_PROXY=(.*)$') {
                $proxyText = $Matches[1].Trim().Trim([char]34, [char]39)
                $proxy = $null
                if ($proxyText -and [Uri]::TryCreate($proxyText, [UriKind]::Absolute, [ref]$proxy) -and $proxy.Scheme -in @('http', 'https') -and $proxy.Host -in @('127.0.0.1', 'localhost', '[::1]') -and -not $proxy.UserInfo -and -not $proxy.Query -and -not $proxy.Fragment) {
                    $networkArgs += @('-c', ('http.proxy=' + $proxy.AbsoluteUri))
                    Write-Host '使用项目已配置的本机代理连接 GitHub。'
                }
            }
        }
    }
    & git @networkArgs push --set-upstream origin $branch
    if ($LASTEXITCODE -ne 0) { throw '上传失败，本地提交已保留。网络恢复后可再次双击；如果提示远程有新提交，请先拉取并处理冲突。' }
    Write-Host '同步完成。' -ForegroundColor Green
} catch {
    Write-Host ('同步未完成：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
