<#
.SYNOPSIS
Build the single-file Windows executable into packaging/dist/.

.DESCRIPTION
The Windows counterpart of scripts/build-deb.sh. Both produce the same artifact -
`packaging/dist/litearm-studio-daemon[.exe]`, built by packaging/build.py - but this
one runs on a Windows machine instead of inside a container.

Why it mirrors the checkout: this repository is normally developed inside WSL, and
PyInstaller over the 9p UNC share is slow and fragile (the build writes tens of
thousands of files). So when -Source is a UNC path the tree is copied to a
Windows-local directory first. When -Source is already local it builds in place.
The copy uses robocopy /MIR, which makes the destination match the source exactly
(files that exist only in the destination are deleted), so point -WorkDir at a
directory this script may own.

Run it on the Windows machine, from any copy of this repository: the script only reads
-Source and writes under -WorkDir, so it does not have to be the tree it builds.

The two SDKs are git submodules of this repository, so the mirror carries them along:
this script clones nothing. Run `make sdk` once in the source checkout after cloning -
the script refuses to build without it.

.PARAMETER Source
Checkout to build. Defaults to the repository this script lives in. Point it at the WSL
checkout (\\wsl.localhost\<distro>\...) to build from there.

.PARAMETER WorkDir
Windows-local build directory: the venv, and the copied tree when mirroring.
Defaults to $env:LITEARM_STUDIO_WIN_DIR, else %USERPROFILE%\litearm-studio-win.

.PARAMETER Python
Interpreter used to create the venv. Defaults to `python` from PATH.

.PARAMETER Version
Version stamped into the executable. Defaults to $env:LITEARM_STUDIO_VERSION, else
`git describe --tags --always` of -Source - the release pipeline passes the git tag the
same way.

.EXAMPLE
.\scripts\build-windows.ps1 -Source \\wsl.localhost\Debian\home\me\litearm\litearm-studio
#>
[CmdletBinding()]
param(
    [string] $Source = (Split-Path -Parent $PSScriptRoot),
    [string] $WorkDir = $(if ($env:LITEARM_STUDIO_WIN_DIR) { $env:LITEARM_STUDIO_WIN_DIR } else { Join-Path $env:USERPROFILE 'litearm-studio-win' }),
    [string] $Python = 'python',
    [string] $Version = $env:LITEARM_STUDIO_VERSION
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path (Join-Path $Source 'packaging\build.py'))) {
    throw "-Source 里没有 packaging/build.py，不是本仓的检出：$Source"
}

if ($Source.StartsWith('\\')) {
    $target = Join-Path $WorkDir 'litearm-studio'
    New-Item -ItemType Directory -Force $WorkDir | Out-Null
    Write-Output "[win] 镜像 $Source -> $target"
    robocopy $Source $target /MIR /XD node_modules .venv .git __pycache__ .pytest_cache .win-build dist-windows /XF *.pyc .git /NFL /NDL /NJH /NJS /NP | Out-Null
    # robocopy 的 0..7 都是成功，8 及以上才是失败。
    if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，退出码 $LASTEXITCODE" }
} else {
    $target = $Source
    Write-Output "[win] 就地构建 $target"
}

foreach ($sdk in @('litearm-python', 'litegrip-python')) {
    $marker = Join-Path $target "sdk\$sdk\pyproject.toml"
    if (-not (Test-Path $marker)) {
        throw "sdk/$sdk 不在检出里（$marker 不存在）：先在源码检出里跑 'make sdk'（或 git submodule update --init --recursive）再重跑本脚本。"
    }
}

if (-not $Version) {
    $Version = & git -C $Source describe --tags --always 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $Version) {
        throw "取不到版本：$Source 不是 git 检出。请显式传 -Version 或设置 LITEARM_STUDIO_VERSION。"
    }
}
$env:LITEARM_STUDIO_VERSION = $Version
Write-Output "[win] 版本 = $Version"

$venv = Join-Path $WorkDir 'venv'
if (-not (Test-Path (Join-Path $venv 'Scripts\python.exe'))) {
    Write-Output "[win] 建 venv：$venv"
    & $Python -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw "建 venv 失败（用的解释器是 $Python）" }
}
$py = Join-Path $venv 'Scripts\python.exe'

& $py -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw 'pip 升级失败' }
& $py -m pip install pyinstaller
if ($LASTEXITCODE -ne 0) { throw 'pyinstaller 安装失败' }

# 机械臂 SDK 从镜像里的 sdk/ 装 —— 与 `make sdk`、CI、.deb 构建同一条路径。
# 夹爪 SDK 不装：它 import 时需要 fcntl / PF_CAN，Windows 上没有，产物里夹爪是缺席的（D10）。
& $py -m pip install (Join-Path $target 'sdk\litearm-python')
if ($LASTEXITCODE -ne 0) { throw 'pip install sdk/litearm-python 失败' }

# `[ui]` 不是可选的：packaging/build.py 在缺 pywebview 时直接判失败 —— 一个开不了窗口的
# 产物里"关掉窗口就是退出"根本不成立。Windows 用系统自带的 WebView2，不需要 Qt。
& $py -m pip install -e (Join-Path $target 'daemon[ui]')
if ($LASTEXITCODE -ne 0) { throw 'pip install -e daemon[ui] 失败' }

Push-Location $target
try {
    & $py packaging\build.py
    if ($LASTEXITCODE -ne 0) { throw 'packaging/build.py 失败' }
} finally {
    Pop-Location
}

Get-ChildItem (Join-Path $target 'packaging\dist') | ForEach-Object { "artifact: $($_.Name) $($_.Length) bytes" }
Write-Output 'BUILD_DONE'
