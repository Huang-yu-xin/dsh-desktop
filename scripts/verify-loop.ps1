# Verify the minimal loop end-to-end on this machine:
#   build -> launch (--workspace skips the picker) -> readiness line parsed
#   -> HTTP 200 -> page loaded -> WM_CLOSE the window -> harness tree gone.
# Requires: npm install already run. Exit code 0 = all checks passed.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
# Launch electron.exe directly: no cmd wrapper, no .cmd shim, no quote pitfalls.
$electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electronExe)) { throw "electron binary not found at $electronExe — run npm install first" }

$testWs = Join-Path $root '.verify-workspace'
New-Item -ItemType Directory -Force -Path $testWs | Out-Null
$shotPath = Join-Path $root '.verify-shot.png'
Remove-Item $shotPath -Force -ErrorAction SilentlyContinue

$appLog = Join-Path $env:APPDATA 'dsh-desktop\dsh-desktop.log'
if (Test-Path $appLog) { Remove-Item $appLog -Force }

# A clean launch environment: no session-scoped DSH_* from an outer harness.
Remove-Item Env:\DSH_SESSION_JSONL, Env:\DSH_SESSION_ID, Env:\DSH_WEB_URL, Env:\DSH_SHELL -ErrorAction SilentlyContinue
$env:DSH_DESKTOP_SHOT = $shotPath

# The test workspace path has no spaces, so Start-Process argument joining is safe.
$p = Start-Process -FilePath $electronExe -ArgumentList @('.', '--workspace', $testWs) -WorkingDirectory $root -PassThru
"launcher pid=$($p.Id) workspace=$testWs"

function Get-AppLogText {
  if (-not (Test-Path $appLog)) { return '' }
  $fs = [System.IO.File]::Open($appLog, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  try { $sr = New-Object System.IO.StreamReader($fs); return $sr.ReadToEnd() } finally { $sr.Close(); $fs.Close() }
}

$checks = [ordered]@{}
# The app must show signs of life quickly; otherwise fail fast instead of
# burning the whole readiness window on a broken launch.
$bootDeadline = (Get-Date).AddSeconds(60)
do { Start-Sleep -Milliseconds 500 } while (-not (Test-Path $appLog) -and @(Get-Process electron -ErrorAction SilentlyContinue).Count -eq 0 -and (Get-Date) -lt $bootDeadline)
if (-not (Test-Path $appLog) -and @(Get-Process electron -ErrorAction SilentlyContinue).Count -eq 0) {
  'RESULT: FAILURES PRESENT (app never started — no electron process and no log file)'
  exit 1
}

$deadline = (Get-Date).AddSeconds(720)
$readyUrl = $null
while ((Get-Date) -lt $deadline) {
  $text = Get-AppLogText
  if ($text -match 'state: ready') { break }
  if ($text -match 'state: failed') { break }
  Start-Sleep -Milliseconds 500
}
$text = Get-AppLogText
if ($text -match 'harness spawned: pid=(\d+)') { $checks['spawned-pid'] = $Matches[1] }
if ($text -match 'state: ready .*url=(http://[^\s]+)') { $readyUrl = $Matches[1]; $checks['readiness-line'] = $readyUrl }

# HTTP confirmation from outside the app.
if ($readyUrl) {
  try {
    $resp = Invoke-WebRequest -Uri $readyUrl -UseBasicParsing -TimeoutSec 15
    $checks['http-status'] = $resp.StatusCode
    $checks['page-title'] = [regex]::Match($resp.Content, '<title>(.*?)</title>').Groups[1].Value
  } catch { $checks['http-status'] = "ERROR: $($_.Exception.Message)" }
}

# Wait for the app's own did-finish-load + screenshot evidence.
$deadline2 = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline2) {
  $text = Get-AppLogText
  if ($text -match 'page loaded: url=http') { break }
  Start-Sleep -Milliseconds 500
}
$text = Get-AppLogText
if ($text -match 'page loaded: url=(http[^\s]+)') { $checks['page-loaded'] = $Matches[1] }
Start-Sleep -Seconds 6
$checks['screenshot'] = if (Test-Path $shotPath) { "saved ($((Get-Item $shotPath).Length) bytes)" } else { 'missing' }

# Clean close: WM_CLOSE to the visible Electron window -> window-all-closed -> quit.
$electronProc = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($electronProc) { $closed = $electronProc.CloseMainWindow(); $checks['window-close-signal'] = "sent (accepted=$closed)" }
$deadline3 = (Get-Date).AddSeconds(30)
do { Start-Sleep -Milliseconds 500; $still = @(Get-Process electron -ErrorAction SilentlyContinue) } while ($still.Count -gt 0 -and (Get-Date) -lt $deadline3)
$checks['electron-exited'] = if ($still.Count -eq 0) { 'yes' } else { "no ($($still.Count) left)" }

# Harness tree must be gone.
$harnessPid = $checks['spawned-pid']
if ($harnessPid) {
  $checks['harness-pid-gone'] = if (Get-Process -Id ([int]$harnessPid) -ErrorAction SilentlyContinue) { 'no — still alive' } else { 'yes' }
}
if ($readyUrl) {
  $port = ([uri]$readyUrl).Port
  $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  $checks['port-closed'] = if ($listeners.Count -eq 0) { "yes (port $port)" } else { "no (port $port still listening)" }
}

''
'=== verification results ==='
$allPass = $true
foreach ($key in $checks.Keys) {
  $value = $checks[$key]
  $ok = $value -notmatch '^(no|missing|ERROR)'
  if (-not $ok) { $allPass = $false }
  "[{0}] {1} = {2}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' }), $key, $value)
}
''
'=== app log tail ==='
Get-AppLogText -split "`n" | Select-Object -Last 25
''
if ($allPass) { 'RESULT: ALL CHECKS PASSED'; exit 0 } else { 'RESULT: FAILURES PRESENT'; exit 1 }
