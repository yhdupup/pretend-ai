# 假装 AI - Windows 引导层（PRD §12.2）
#
# 为什么用 PowerShell 而不是把逻辑写在 .bat 里：要读 JSON、算 SHA-256、解压、判断架构，
# 这些在 cmd 里写出来没人能维护。.bat 只负责把这个文件拉起来。
#
# 它仍然只做「不依赖 Node 的那部分」：
#   1. 定位项目根（.bat 被拷到桌面也能找回原来的目录）
#   2. 读 runtime-manifest.json，按平台算出该用哪个 Node 包与哪个 SHA-256
#   3. 没有项目专用 Node 就下载 → 校验 → 才解压（对不上就删掉，绝不解压执行）
#   4. 之后一切交给 scripts\bootstrap.mjs（可测试的准备层）
#
# 只支持 64 位 Windows 10/11：下载用的 tar（bsdtar）是 Win10 1803 起系统自带的，
# 校验用 Get-FileHash（PowerShell 5.1+）。这两样都没有的机器，本项目不支持。

param(
    [ValidateSet("start", "stop")]
    [string]$Action = "start",
    [switch]$NoOpen,
    [string[]]$ExtraArgs = @()
)

$ErrorActionPreference = "Stop"
$script:ExitEnv = 3

function Die([string]$message, [string]$hint = "", [int]$code = 3) {
    Write-Host ""
    Write-Host "启动失败：$message" -ForegroundColor Red
    if ($hint) { Write-Host "怎么办：$hint" -ForegroundColor DarkGray }
    Write-Host ""
    Write-Host "需要帮助：打开项目文件夹里的 docs\启动失败手动处理.md" -ForegroundColor DarkGray
    exit $code
}

# 1) 定位项目根：本文件在项目根的 scripts\ 下；被拷走时回落到当前目录。
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root "runtime-manifest.json"))) { $Root = (Get-Location).Path }
if (-not (Test-Path (Join-Path $Root "runtime-manifest.json"))) {
    Die "找不到 runtime-manifest.json" "你拷贝的是零散文件，不是完整项目目录；请把整个项目文件夹拷过来"
}
Set-Location $Root

# 2) 架构：只出 win-x64。
if (-not [Environment]::Is64BitOperatingSystem) {
    Die "这台电脑是 32 位 Windows，本项目不支持" "换 64 位的 Windows 10/11"
}
$Target = "win-x64"

try {
    $Manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $Root "runtime-manifest.json") | ConvertFrom-Json
} catch {
    Die "runtime-manifest.json 读不出来" "文件可能不完整，重新获取整个项目目录"
}

$NodeVersion = $Manifest.node.version
if (-not $NodeVersion) { Die "runtime-manifest.json 里缺 node.version" "重新获取完整项目目录" }
if ($NodeVersion -notmatch '^v') { $NodeVersion = "v$NodeVersion" }

$NodeEntry = $Manifest.node.targets.$Target
if (-not $NodeEntry -or -not $NodeEntry.sha256) {
    Die "清单里没有 $Target 的校验值，这一版项目没为这台机器把过关" `
        "不要在本地改清单凑数；找作者用 coding\scripts\gen-runtime-manifest.mjs 生成"
}
$Expected = $NodeEntry.sha256
$Package = if ($NodeEntry.artifact) { $NodeEntry.artifact } else { "node-$NodeVersion-$Target.zip" }

$NodeHome = Join-Path $Root ".runtime\node\$NodeVersion\$Target"
$NodeExe = Join-Path $NodeHome "node.exe"

# 3) 需要时才下载。镜像只能换主机，不能换校验值。
if (-not (Test-Path $NodeExe)) {
    $base = if ($env:AIWINDOW_NODE_BASE) { $env:AIWINDOW_NODE_BASE.TrimEnd('/') } else { $Manifest.node.mirrorBase.TrimEnd('/') }
    $url = "$base/$NodeVersion/$Package"
    $downloadDir = Join-Path $Root ".runtime\download"
    New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
    New-Item -ItemType Directory -Force -Path $NodeHome | Out-Null
    $part = Join-Path $downloadDir "$Package.part"
    if (Test-Path $part) { Remove-Item $part -Force }

    Write-Host "[下载 Node 运行环境] $url"
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $url -OutFile $part -UseBasicParsing -TimeoutSec 900
    } catch {
        if (Test-Path $part) { Remove-Item $part -Force }
        Die "下载失败：$url" "检查网络后重新双击；要换镜像就设环境变量 AIWINDOW_NODE_BASE（校验值不变）" 7
    }

    Write-Host "[校验运行环境]"
    $actual = (Get-FileHash -Algorithm SHA256 $part).Hash
    if ($actual -ne $Expected) {
        Remove-Item $part -Force
        Die "下载到的 Node 与清单校验值不一致，已删除，不会解压执行" `
            "多半是网络被劫持或镜像不对；换网络重试" 7
    }
    Write-Host "    校验通过 sha256 $($Expected.Substring(0,12))…" -ForegroundColor Green

    # bsdtar 认 zip，--strip-components 1 正好去掉包里的 node-vX.Y.Z-win-x64 这层目录。
    try {
        & tar -xf $part -C $NodeHome --strip-components 1
        if ($LASTEXITCODE -ne 0) { throw "tar 退出码 $LASTEXITCODE" }
    } catch {
        Remove-Item $part -Force
        Die "解压失败：$_" "重新双击试一次；反复失败就把这一段发给作者" 3
    }
    Remove-Item $part -Force

    if (-not (Test-Path $NodeExe)) { Die "解压后找不到 node.exe" "删除 .runtime 目录后重新双击" }
}

# 4) 交给准备层（后面所有事都在 scripts\*.mjs 里，可测试）
$args = @()
if ($Action -eq "stop") {
    Write-Host "[停止]"
    & $NodeExe (Join-Path $Root "scripts\stop.mjs") @args @ExtraArgs
} else {
    if ($NoOpen) { $args += "--no-open" }
    Write-Host "[准备项目] 第一次会装依赖并构建，可能需要几分钟"
    & $NodeExe (Join-Path $Root "scripts\bootstrap.mjs") @args @ExtraArgs
}
$code = $LASTEXITCODE
if ($code -ne 0) {
    Write-Host ""
    Write-Host "流程未成功，退出码 $code。上面最后几行就是原因；运行日志在 logs 目录。" -ForegroundColor Red
}
exit $code
