<#
.SYNOPSIS
Name, checksum and publish the Windows executable built by scripts/build-windows.ps1.

.DESCRIPTION
Copies `packaging/dist/litearm-studio-daemon.exe` into an output directory under the
release asset name (`litearm-studio-<version>-windows-amd64.exe`), writes the `.sha256`
sidecar with packaging/checksums.py, and optionally copies both to a second location.

The name and the sidecar are the ones the `package` job of release.yml uploads, so a
locally produced file is interchangeable with a released one.

.PARAMETER Artifact
Executable to publish. Defaults to this repository's packaging/dist/litearm-studio-daemon.exe.
Pass the path under your -WorkDir when the build ran against a mirrored tree.

.PARAMETER Version
Version for the asset name. Defaults to $env:LITEARM_STUDIO_VERSION, else
`git describe --tags --always`. A leading `v` is stripped, as the release job does.

.PARAMETER OutDir
Where the named copy and its `.sha256` land. Defaults to <repo>\upload.

.PARAMETER CopyTo
Optional second destination for both files, e.g. $env:USERPROFILE\Desktop.

.PARAMETER Python
Interpreter that runs packaging/checksums.py. Defaults to `python` from PATH.
#>
[CmdletBinding()]
param(
    [string] $Artifact = (Join-Path (Split-Path -Parent $PSScriptRoot) 'packaging\dist\litearm-studio-daemon.exe'),
    [string] $Version = $env:LITEARM_STUDIO_VERSION,
    [string] $OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'upload'),
    [string] $CopyTo,
    [string] $Python = 'python'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Artifact)) {
    throw "找不到产物：$Artifact —— 先跑 scripts/build-windows.ps1。"
}

# 产物在 <repo>\packaging\dist\ 下，所以仓库根是它上面两层：checksums.py 要按仓库根调用。
$repo = Split-Path -Parent (Split-Path -Parent $Artifact)
if (-not (Test-Path (Join-Path $repo 'packaging\checksums.py'))) {
    throw "从 $Artifact 推不出仓库根（$repo 里没有 packaging/checksums.py）：请让 -Artifact 指向 <repo>\packaging\dist\ 下的产物。"
}

if (-not $Version) {
    $Version = & git -C $repo describe --tags --always 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $Version) {
        throw '取不到版本：请传 -Version 或设置 LITEARM_STUDIO_VERSION。'
    }
}
$name = "litearm-studio-$($Version.TrimStart('v'))-windows-amd64.exe"

New-Item -ItemType Directory -Force $OutDir | Out-Null
# 只清掉本脚本上一批产出的同名族文件：checksums.py 会给目录里每个文件算一遍，残留的旧
# 产物会一起进校验和。刻意不用通配清空整个目录 —— -OutDir 指错一次就是灾难。
Get-ChildItem $OutDir -File -Filter 'litearm-studio-*-windows-amd64.exe*' | Remove-Item -Force
Copy-Item $Artifact (Join-Path $OutDir $name) -Force

Push-Location $repo
try {
    & $Python packaging\checksums.py $OutDir
    if ($LASTEXITCODE -ne 0) { throw 'packaging/checksums.py 失败' }
} finally {
    Pop-Location
}

$sidecar = Join-Path $OutDir "$name.sha256"
if (-not (Test-Path $sidecar)) { throw "校验和旁文件没生成：$sidecar" }

if ($CopyTo) {
    New-Item -ItemType Directory -Force $CopyTo | Out-Null
    Copy-Item (Join-Path $OutDir $name) $CopyTo -Force
    Copy-Item $sidecar $CopyTo -Force
    Write-Output "[win] 已复制到 $CopyTo"
}

Get-ChildItem $OutDir -File | ForEach-Object { "asset: $($_.Name) $($_.Length) bytes" }
Write-Output 'DEPLOY_DONE'
