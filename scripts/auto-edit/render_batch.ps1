# 批次渲染 worker：串行跑一格（Mod/Of）的清单，跳过已成片，逐条落日志
#
# 用法（BatchManifest 生成的清单）：
#   pwsh -File scripts/auto-edit/render_batch.ps1 -List tmp/render_list.json -Mod 0 -Of 2
#   pwsh -File scripts/auto-edit/render_batch.ps1 -List tmp/render_list.json -Mod 1 -Of 2
#
# 约定：
# - 渲染阶段一律 --no-move，源素材由 archive_sources.py 统一归档（渲染中途失败不留半套状态）。
# - 已存在的成片直接跳过，重跑同一批次不会重复渲染。
# - 并发度由 -Of 决定：本机实测 2 路串行最稳；8 路并发会争 CPU/GPU，单条从 ~60s 涨到 85s~20min。

param(
    [Parameter(Mandatory = $true)][string]$List,
    [string]$Config = "runtime/auto-edit/config-z-new.json",
    [int]$Mod = 0,
    [int]$Of = 1,
    [string]$OutDir = "Z:\暂时不用素材\团购\已剪成片",
    [string]$Log = "tmp/render_batch.log"
)

$ErrorActionPreference = "Continue"
$root = "D:\@kaifa\tuangou"
Set-Location $root
$py = "C:\Users\Administrator\AppData\Local\Programs\Python\Python311\python.exe"

$items = Get-Content -LiteralPath $List -Encoding utf8 -Raw | ConvertFrom-Json
if (Test-Path -LiteralPath $Log) { Remove-Item -LiteralPath $Log }
$fail = @()
$i = 0

foreach ($row in $items) {
    $idx = $i
    $i++
    if (($idx % $Of) -ne $Mod) { continue }

    $outPath = Join-Path $OutDir $row.name
    if (Test-Path -LiteralPath $outPath) {
        Add-Content -LiteralPath $Log -Value ("[skip] " + $row.name) -Encoding utf8
        continue
    }

    Add-Content -LiteralPath $Log -Value ("[start] " + $row.stem + " -> " + $row.name) -Encoding utf8
    $cmdArgs = @("scripts/auto-edit/auto_edit.py", "--config", $Config,
              "--clip", $row.stem, "--name", $row.name, "--no-move")
    & $py $cmdArgs 2>&1 | Out-File -LiteralPath ($Log + "." + ($idx)) -Encoding utf8 -Append
    $code = $LASTEXITCODE
    Add-Content -LiteralPath $Log -Value ("[done] " + $row.name + " exit=" + $code) -Encoding utf8
    if ($code -ne 0) { $fail += $row.name }
}

if ($fail.Count -gt 0) {
    Add-Content -LiteralPath $Log -Value ("[worker $Mod] 失败 " + $fail.Count + " 条: " + ($fail -join ", ")) -Encoding utf8
    exit 1
}
Add-Content -LiteralPath $Log -Value ("[worker $Mod] finished, 全成功") -Encoding utf8
