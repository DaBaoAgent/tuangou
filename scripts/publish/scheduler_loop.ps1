# 免管理员的本地排期守护（2026-11-14 本机接手发布时建）
# 节奏与 TY 的 TuangouPublish / TuangouPrepare / TuangouStats 一致：
#   run_due.js   每 5 分钟（05:00-19:59）
#   prepare.js   每 30 分钟（06:12 / 06:42 ... 19:12）
#   stats_fetch  每天 09:20 / 21:20
# 由 HKCU Run 键在登录时拉起，窗口隐藏；run_due/prepare 自带 run.lock，重复触发会被跳过。

$root = 'D:\@kaifa\tuangou'
$node = 'C:\Program Files\nodejs\node.exe'
$logDir = Join-Path $root 'runtime\publish\logs'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir 'scheduler.log'

function Say($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -LiteralPath $log -Value $line -Encoding utf8
}

function Fire($script) {
  try {
    Start-Process -FilePath $node -ArgumentList (Join-Path $root "scripts\publish\$script") -WorkingDirectory $root -WindowStyle Hidden
    Say "start $script"
  } catch {
    Say "fail $script : $($_.Exception.Message)"
  }
}

Say "scheduler_loop start pid=$PID"
$lastPublish = ''
$lastPrepare = ''
$lastStats = ''

while ($true) {
  $now = Get-Date
  $hm = $now.ToString('HH:mm')
  $min = $now.Minute

  if (($min % 5) -eq 0 -and $hm -ne $lastPublish -and $now.Hour -ge 5 -and $now.Hour -lt 20) {
    Fire 'run_due.js'
    $lastPublish = $hm
  }

  if (($min -eq 12 -or $min -eq 42) -and $hm -ne $lastPrepare -and $now.Hour -ge 6 -and $now.Hour -lt 20) {
    Fire 'prepare.js'
    $lastPrepare = $hm
  }

  if (($hm -eq '09:20' -or $hm -eq '21:20') -and $hm -ne $lastStats) {
    Fire 'stats_fetch.js'
    $lastStats = $hm
  }

  Start-Sleep -Seconds 30
}
