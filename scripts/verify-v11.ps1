# V1.1 reliability verification orchestrator. Runs real Electron + real
# Harness scenarios and prints a PASS/FAIL matrix. Exit code 0 = all passed.
#
#   .\scripts\verify-v11.ps1 [scenario|all]
#   scenarios: crash | disconnect | back | window | logs | single | ipc | all
# The real-agent and long-task scenarios are run separately by the caller
# (they need the real DSH_HOME and the live model).
param([string]$Scenario = 'all', [string]$ExePath = '')
$ErrorActionPreference = 'Stop'
$root = 'D:\software\dsh-desktop'
$appLog = Join-Path $env:APPDATA 'dsh-desktop\dsh-desktop.log'
$userData = Join-Path $env:APPDATA 'dsh-desktop'
# DEV default: the Electron binary from the project tree. PACKAGED runs pass
# -ExePath pointing at the built/installed "DeepSeek Harness Desktop.exe".
$electronExe = if ($ExePath) { $ExePath } else { Join-Path $root 'node_modules\electron\dist\electron.exe' }
$AppProcName = [System.IO.Path]::GetFileNameWithoutExtension($electronExe)   # dev: electron, packaged: DeepSeek Harness Desktop
$driver = Join-Path $root 'scripts\verify-v11.mjs'
$testHome = Join-Path $root '.verify-v11-home'
$testWsA = Join-Path $root '.verify-workspace'
$testWsB = Join-Path $root '.verify-v11-ws-b'
New-Item -ItemType Directory -Force -Path $testWsA, $testWsB | Out-Null

# Hygiene: a leftover desktop instance would make the single-instance lock
# reject every new launch, so clean electron processes before the suite runs.
$leftovers = @(Get-Process electron -ErrorAction SilentlyContinue)
if ($leftovers.Count -gt 0) {
  taskkill /IM electron.exe /T /F 2>&1 | Out-Null
  if ($AppProcName -ne 'electron') { taskkill /IM ($AppProcName + '.exe') /T /F 2>&1 | Out-Null }
  Start-Sleep -Seconds 2
  "hygiene: terminated $($leftovers.Count) leftover electron process(es)"
}

# ---- suspend/resume (simulates "process alive, HTTP dead") ----
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ProcSuspend {
    [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);
    [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint a, bool i, int p);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
    public static bool Suspend(int pid) { var h = OpenProcess(0x0800, false, pid); if (h == IntPtr.Zero) return false; var r = NtSuspendProcess(h) == 0; CloseHandle(h); return r; }
    public static bool Resume(int pid) { var h = OpenProcess(0x0800, false, pid); if (h == IntPtr.Zero) return false; var r = NtResumeProcess(h) == 0; CloseHandle(h); return r; }
}
'@

function Get-TreePids([int]$RootPid) {
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $result = [System.Collections.Generic.List[int]]::new()
  $queue = [System.Collections.Generic.Queue[int]]::new()
  $queue.Enqueue($RootPid)
  while ($queue.Count -gt 0) {
    $p = $queue.Dequeue()
    if ($result.Contains($p)) { continue }
    $result.Add($p)
    foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $p })) { $queue.Enqueue([int]$c.ProcessId) }
  }
  return ,$result.ToArray()
}

function Suspend-Tree([int]$RootPid) {
  foreach ($p in (Get-TreePids $RootPid)) { $null = [ProcSuspend]::Suspend($p) }
  "suspended tree of $RootPid"
}

function Resume-Tree([int]$RootPid) {
  foreach ($p in (Get-TreePids $RootPid)) { $null = [ProcSuspend]::Resume($p) }
  "resumed tree of $RootPid"
}

# ---- helpers ----
$script:Results = [System.Collections.Generic.List[object]]::new()
function Add-Check([string]$Name, [bool]$Pass, [string]$Evidence) {
  $script:Results.Add([pscustomobject]@{ Name = $Name; Pass = $Pass; Evidence = $Evidence })
  "[{0}] {1}  {2}" -f ($(if ($Pass) { 'PASS' } else { 'FAIL' }), $Name, $Evidence)
}

function Get-AppLogText {
  if (-not (Test-Path $appLog)) { return '' }
  $fs = [System.IO.File]::Open($appLog, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  try { $sr = New-Object System.IO.StreamReader($fs); return $sr.ReadToEnd() } finally { $sr.Close(); $fs.Close() }
}

function Wait-AppLog([string]$Pattern, [int]$TimeoutSec, [int]$Occurrence = 1) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    Start-Sleep -Milliseconds 400
    $text = Get-AppLogText
    if (([regex]::Matches($text, $Pattern)).Count -ge $Occurrence) { return $true }
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Start-App([string[]]$ExtraArgs, [string]$DshHome, [int]$CdpPort = 9333) {
  Remove-Item $appLog -Force -ErrorAction SilentlyContinue
  Remove-Item Env:\DSH_SESSION_JSONL, Env:\DSH_SESSION_ID, Env:\DSH_WEB_URL, Env:\DSH_SHELL -ErrorAction SilentlyContinue
  if ($DshHome) { $env:DSH_HOME = $DshHome } else { Remove-Item Env:\DSH_HOME -ErrorAction SilentlyContinue }
  $args = @('.') + $ExtraArgs + @("--remote-debugging-port=$CdpPort")
  return Start-Process -FilePath $electronExe -ArgumentList $args -WorkingDirectory $root -PassThru
}

function Close-App {
  $proc = Get-Process -Name $AppProcName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($proc) { $null = $proc.CloseMainWindow() }
  $deadline = (Get-Date).AddSeconds(30)
  do { Start-Sleep -Milliseconds 500; $still = @(Get-Process -Name $AppProcName -ErrorAction SilentlyContinue) } while ($still.Count -gt 0 -and (Get-Date) -lt $deadline)
  return $still.Count -eq 0
}

function Get-LastSpawn([string]$LogText) {
  $m = [regex]::Matches($LogText, 'harness spawned: pid=(\d+)')
  if ($m.Count -eq 0) { return $null }
  return $m[$m.Count - 1].Groups[1].Value
}

function Get-LastReadyUrl([string]$LogText) {
  $m = [regex]::Matches($LogText, 'state: ready .*url=(http://[^\s]+)')
  if ($m.Count -eq 0) { return $null }
  return $m[$m.Count - 1].Groups[1].Value
}

function Get-PortClosed([string]$Url) {
  $port = ([uri]$Url).Port
  return @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count -eq 0
}

function Test-HttpOk([string]$Url) {
  try { $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 15; return $r.StatusCode -eq 200 } catch { return $false }
}

# ── scenario: crash recovery ────────────────────────────────────────────────
function Test-CrashRecovery {
  ''
  '=== scenario: crash recovery ==='
  $app = Start-App @('--workspace', $testWsA) $testHome
  if (-not (Wait-AppLog 'state: ready' 180)) { Add-Check 'crash:initial-ready' $false 'timeout'; $null = Close-App; return }
  $log = Get-AppLogText
  $pid1 = Get-LastSpawn $log
  $url1 = Get-LastReadyUrl $log
  Add-Check 'crash:initial-ready' ([bool]($pid1 -and $url1)) "pid=$pid1 url=$url1"

  taskkill /PID $pid1 /T /F 2>&1 | Out-Null
  if (-not (Wait-AppLog 'state: failed' 30)) { Add-Check 'crash:detected' $false 'no failed state'; $null = Close-App; return }
  $log = Get-AppLogText
  Add-Check 'crash:detected' ($log -match 'state: failed .*reason=process-exited') 'failed + reason=process-exited'
  Add-Check 'crash:electron-alive' ([bool](Get-Process -Id $app.Id -ErrorAction SilentlyContinue)) "electron pid=$($app.Id) alive"

  node $driver lost-assert "$root\.verify-v11-lost1.json" 2>&1 | Out-Null
  $lost = Get-Content "$root\.verify-v11-lost1.json" -Raw | ConvertFrom-Json
  Add-Check 'crash:lost-page' ($lost.lostVisible -and $lost.bodyHasConnectionLost -and $lost.hasRestart -and $lost.hasBack) "workspace=$($lost.lostWorkspace)"

  node $driver click-restart 2>&1 | Out-Null
  # Occurrence 2: the first 'state: ready' line in the log is from the
  # crashed instance; the restart must produce a second one.
  if (-not (Wait-AppLog 'state: ready' 180 2)) { Add-Check 'crash:restart-ready' $false 'no second ready state'; $null = Close-App; return }
  $log = Get-AppLogText
  $pid2 = Get-LastSpawn $log
  $url2 = Get-LastReadyUrl $log
  Add-Check 'crash:restart-new-pid' ($pid2 -and $pid1 -ne $pid2) "pid $pid1 -> $pid2"
  # The port may legitimately be reused by the OS after the old instance
  # released it; the assertion that matters is the new backend serving 200.
  Add-Check 'crash:restart-http-200' (Test-HttpOk $url2) "$url2 (old was $url1)"
  # loadURL completes after the ready event: wait for the second page load.
  $secondLoad = Wait-AppLog 'page loaded: url=http' 90 2
  $loads = ([regex]::Matches((Get-AppLogText), 'page loaded: url=http')).Count
  Add-Check 'crash:restart-ui-restored' ($secondLoad -and $loads -ge 2) "http page loads=$loads"
  $closed = Close-App
  Add-Check 'crash:clean-quit' $closed 'electron exited'
  Add-Check 'crash:pid2-gone' (-not [bool](Get-Process -Id ([int]$pid2) -ErrorAction SilentlyContinue)) "pid $pid2 gone"
  Add-Check 'crash:port2-closed' (Get-PortClosed $url2) $url2
}

# ── scenario: http disconnect (suspend simulation) ──────────────────────────
function Test-HttpDisconnect {
  ''
  '=== scenario: http disconnect (process alive, HTTP unresponsive) ==='
  $app = Start-App @('--workspace', $testWsA) $testHome
  if (-not (Wait-AppLog 'state: ready' 180)) { Add-Check 'disconnect:initial-ready' $false 'timeout'; $null = Close-App; return }
  $log = Get-AppLogText
  $pid1 = Get-LastSpawn $log
  $url1 = Get-LastReadyUrl $log
  Add-Check 'disconnect:initial-ready' ([bool]($pid1 -and $url1)) "pid=$pid1"

  Suspend-Tree ([int]$pid1)
  if (-not (Wait-AppLog 'state: disconnected' 90)) { Add-Check 'disconnect:detected' $false 'timeout'; $null = Close-App; return }
  $log = Get-AppLogText
  Add-Check 'disconnect:detected' ($log -match 'state: disconnected .*reason=health-check-failed') 'disconnected + health-check-failed'
  Add-Check 'disconnect:process-alive' ([bool](Get-Process -Id ([int]$pid1) -ErrorAction SilentlyContinue)) "pid $pid1 alive"
  Add-Check 'disconnect:no-auto-kill' ($log -notmatch 'state: stopping') 'no stopping state before user action'
  node $driver lost-assert "$root\.verify-v11-lost2.json" 2>&1 | Out-Null
  $lost = Get-Content "$root\.verify-v11-lost2.json" -Raw | ConvertFrom-Json
  Add-Check 'disconnect:lost-page' $lost.lostVisible 'lost page shown'

  Resume-Tree ([int]$pid1)
  node $driver click-restart 2>&1 | Out-Null
  if (-not (Wait-AppLog 'state: ready' 180 2)) { Add-Check 'disconnect:restart-ready' $false 'no second ready state'; $null = Close-App; return }
  $log = Get-AppLogText
  $pid2 = Get-LastSpawn $log
  $url2 = Get-LastReadyUrl $log
  Add-Check 'disconnect:restart-new-pid' ($pid2 -and $pid1 -ne $pid2) "pid $pid1 -> $pid2"
  Add-Check 'disconnect:restart-http-200' (Test-HttpOk $url2) $url2
  Add-Check 'disconnect:old-pid-gone' (-not ([bool](Get-Process -Id ([int]$pid1) -ErrorAction SilentlyContinue))) "old pid $pid1 gone"
  $closed = Close-App
  Add-Check 'disconnect:clean-quit' $closed 'electron exited'
  Add-Check 'disconnect:port1-closed' (Get-PortClosed $url1) $url1
}

# ── scenario: back to workspaces ────────────────────────────────────────────
function Test-BackToWorkspaces {
  ''
  '=== scenario: back to workspaces ==='
  $recentsFile = Join-Path $userData 'recent-workspaces.json'
  $seed = @(
    @{ path = $testWsA; lastOpenedAt = 1786000000000 },
    @{ path = $testWsB; lastOpenedAt = 1785000000000 }
  ) | ConvertTo-Json
  Set-Content -Path $recentsFile -Value $seed -Encoding utf8

  $app = Start-App @('--workspace', $testWsA) $testHome
  if (-not (Wait-AppLog 'state: ready' 180)) { Add-Check 'back:initial-ready' $false 'timeout'; $null = Close-App; return }
  $log = Get-AppLogText
  $pid1 = Get-LastSpawn $log
  $url1 = Get-LastReadyUrl $log
  Add-Check 'back:initial-ready' ([bool]($pid1 -and $url1)) "pid=$pid1"

  # Drive the native menu accelerator (Ctrl+Shift+B) like a user would.
  # Window focus is racy from a background shell, so retry with restore+focus,
  # then fall back to CDP-dispatched key events.
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class FocusHelper { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd); }'
  $acceleratorFired = $false
  for ($attempt = 0; $attempt -lt 4 -and -not $acceleratorFired; $attempt++) {
    $main = Get-Process -Id $app.Id -ErrorAction SilentlyContinue
    if ($main -and $main.MainWindowHandle -ne 0) {
      $null = [FocusHelper]::ShowWindow($main.MainWindowHandle, 9)
      $null = [FocusHelper]::SetForegroundWindow($main.MainWindowHandle)
      Start-Sleep -Milliseconds 800
      try { [System.Windows.Forms.SendKeys]::SendWait('^+b') } catch { "SendKeys attempt ${attempt}: $($_.Exception.Message)" }
      Start-Sleep -Milliseconds 1500
      if (Wait-AppLog 'state: idle' 2) { $acceleratorFired = $true; break }
    } else {
      Start-Sleep -Seconds 1
    }
  }
  if (-not $acceleratorFired) {
    node $driver send-accel back 2>&1 | Out-Null
    $acceleratorFired = Wait-AppLog 'state: idle' 15
  }
  if (-not $acceleratorFired) { Add-Check 'back:stopped' $false 'no idle state after accelerator'; $null = Close-App; return }
  Add-Check 'back:stopped' $true 'idle after Back'
  Add-Check 'back:old-pid-gone' (-not ([bool](Get-Process -Id ([int]$pid1) -ErrorAction SilentlyContinue))) "pid $pid1 gone"
  Add-Check 'back:old-port-closed' (Get-PortClosed $url1) $url1
  node $driver dump "$root\.verify-v11-back.txt" 2>&1 | Out-Null
  $dump = Get-Content "$root\.verify-v11-back.txt" -Raw
  Add-Check 'back:choose-page' ($dump -match 'Choose a workspace to start') 'choose page shown'

  # Open workspace B from the recents list.
  node $driver click-recent (Split-Path $testWsB -Leaf) 2>&1 | Out-String
  # Second ready state: the first one was workspace A (already in the log).
  if (-not (Wait-AppLog 'state: ready' 180 2)) { Add-Check 'back:workspace-b-ready' $false 'no second ready state'; $null = Close-App; return }
  $log = Get-AppLogText
  $pid2 = Get-LastSpawn $log
  $url2 = Get-LastReadyUrl $log
  Add-Check 'back:workspace-b-ready' ($pid2 -and $pid1 -ne $pid2) "new pid=$pid2 url=$url2"
  Add-Check 'back:workspace-b-http-200' (Test-HttpOk $url2) $url2
  $closed = Close-App
  Add-Check 'back:clean-quit' $closed 'electron exited'
  Remove-Item $recentsFile -Force -ErrorAction SilentlyContinue
}

# ── scenario: window state ──────────────────────────────────────────────────
function Test-WindowState {
  ''
  '=== scenario: window state ==='
  $stateFile = Join-Path $userData 'window-state.json'

  # valid preset -> applied -> close (saves) -> reopen -> restored
  Set-Content -Path $stateFile -Value '{"width":1100,"height":700,"x":120,"y":100,"maximized":false}' -Encoding utf8
  $app = Start-App @() $null
  Start-Sleep -Seconds 6
  node $driver window-info "$root\.verify-v11-win1.json" 2>&1 | Out-Null
  $info = Get-Content "$root\.verify-v11-win1.json" -Raw | ConvertFrom-Json
  Add-Check 'window:valid-applied' ([Math]::Abs($info.outerWidth - 1100) -le 80 -and [Math]::Abs($info.outerHeight - 700) -le 80 -and [Math]::Abs($info.screenX - 120) -le 60 -and [Math]::Abs($info.screenY - 100) -le 60) "outer=$($info.outerWidth)x$($info.outerHeight) at $($info.screenX),$($info.screenY)"
  $closed = Close-App
  Add-Check 'window:clean-quit-1' $closed 'electron exited'

  $saved = Get-Content $stateFile -Raw | ConvertFrom-Json
  Add-Check 'window:saved-on-close' ($saved.width -ge 1000 -and $saved.width -le 1200 -and $saved.height -ge 600) "saved=$($saved.width)x$($saved.height)"

  $app = Start-App @() $null
  Start-Sleep -Seconds 6
  node $driver window-info "$root\.verify-v11-win2.json" 2>&1 | Out-Null
  $info2 = Get-Content "$root\.verify-v11-win2.json" -Raw | ConvertFrom-Json
  Add-Check 'window:restored' ([Math]::Abs($info2.outerWidth - $saved.width) -le 100 -and [Math]::Abs($info2.outerHeight - $saved.height) -le 100) "reopened=$($info2.outerWidth)x$($info2.outerHeight) saved=$($saved.width)x$($saved.height)"
  $closed = Close-App
  Add-Check 'window:clean-quit-2' $closed 'electron exited'

  # invalid coordinates -> falls back to a visible position
  Set-Content -Path $stateFile -Value '{"width":1100,"height":700,"x":99999,"y":99999,"maximized":false}' -Encoding utf8
  $app = Start-App @() $null
  Start-Sleep -Seconds 6
  node $driver window-info "$root\.verify-v11-win3.json" 2>&1 | Out-Null
  $info3 = Get-Content "$root\.verify-v11-win3.json" -Raw | ConvertFrom-Json
  Add-Check 'window:invalid-coords-visible' ($info3.screenX -lt 20000 -and $info3.screenY -lt 20000 -and [Math]::Abs($info3.outerWidth - 1100) -le 80) "at $($info3.screenX),$($info3.screenY) size $($info3.outerWidth)x$($info3.outerHeight)"
  $closed = Close-App
  Add-Check 'window:clean-quit-3' $closed 'electron exited'
  Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
}

# ── scenario: logs viewer + sanitization ────────────────────────────────────
function Test-Logs {
  ''
  '=== scenario: logs viewer + sanitization ==='
  $unit = node (Join-Path $root 'scripts\check-sanitize.mjs') 2>&1 | Out-String
  Add-Check 'logs:sanitize-unit' ($LASTEXITCODE -eq 0) ($unit -split "`n" | Select-Object -Last 1)

  $app = Start-App @('--workspace', $testWsA) $testHome
  if (-not (Wait-AppLog 'state: ready' 180)) { Add-Check 'logs:initial-ready' $false 'timeout'; $null = Close-App; return }
  $log = Get-AppLogText
  $pid1 = Get-LastSpawn $log
  taskkill /PID $pid1 /T /F 2>&1 | Out-Null
  $null = Wait-AppLog 'state: failed' 30

  node $driver click-show-logs 2>&1 | Out-Null
  node $driver logs-dump "$root\.verify-v11-logs.json" 2>&1 | Out-Null
  $logs = Get-Content "$root\.verify-v11-logs.json" -Raw | ConvertFrom-Json
  Add-Check 'logs:panel-shown' ($logs.panelVisible -and $logs.hasStdoutLabel -and $logs.hasStderrLabel) 'panel + stdout/stderr labels'
  Add-Check 'logs:stdout-has-harness-output' ($logs.stdout -match 'dsh web:') 'harness stdout captured'
  Add-Check 'logs:no-raw-secrets' ($logs.stdout -notmatch 'sk-[A-Za-z0-9_-]{12,}' -and $logs.stderr -notmatch 'sk-[A-Za-z0-9_-]{12,}') 'no sk- pattern in panel'

  node $driver click-copy-logs 2>&1 | Out-Null
  # Product-side evidence: the main process logs the sanitized copy payload.
  $copyOk = Wait-AppLog 'copy-logs: wrote \d+ sanitized chars' 15
  $copyLine = [regex]::Match((Get-AppLogText), 'copy-logs: wrote [^\r\n]+').Value
  # Best-effort read-back of the system clipboard (unavailable in some
  # sandboxed shells — treated as informational only).
  Start-Sleep -Milliseconds 800
  $clip = Get-Clipboard -Raw -ErrorAction SilentlyContinue
  Add-Check 'logs:copy-logs' $copyOk "$copyLine (clipboard read-back: $($clip.Length) chars)"
  $closed = Close-App
  Add-Check 'logs:clean-quit' $closed 'electron exited'
}

# ── scenario: single instance ───────────────────────────────────────────────
function Test-SingleInstance {
  ''
  '=== scenario: single instance ==='
  $appA = Start-App @('--workspace', $testWsA) $testHome 9333
  if (-not (Wait-AppLog 'state: ready' 180)) { Add-Check 'single:initial-ready' $false 'timeout'; $null = Close-App; return }
  $log = Get-AppLogText
  $pid1 = Get-LastSpawn $log
  $spawnCount1 = ([regex]::Matches($log, 'harness spawned: pid=(\d+)')).Count
  Add-Check 'single:initial-ready' ([bool]$pid1) "pid=$pid1"

  # Launch B WITHOUT touching the shared app log (Start-App deletes it,
  # which would erase A's spawn/ready evidence).
  $argsB = @('.', '--workspace', $testWsA, '--remote-debugging-port=9334')
  $env:DSH_HOME = $testHome
  $appB = Start-Process -FilePath $electronExe -ArgumentList $argsB -WorkingDirectory $root -PassThru
  $bExited = $appB.WaitForExit(20000)
  Add-Check 'single:second-instance-exits' $bExited "B exited=$bExited"
  Start-Sleep -Seconds 2
  $log = Get-AppLogText
  Add-Check 'single:first-activated' ($log -match 'second-instance: activating existing window') 'second-instance handled'
  Add-Check 'single:first-alive' ([bool](Get-Process -Id $appA.Id -ErrorAction SilentlyContinue)) "A pid=$($appA.Id) alive"
  $spawnCount2 = ([regex]::Matches($log, 'harness spawned: pid=(\d+)')).Count
  Add-Check 'single:no-second-backend' ($spawnCount1 -eq $spawnCount2 -and $spawnCount2 -eq 1) "spawn lines=$spawnCount2"
  $closed = Close-App
  Add-Check 'single:clean-quit' $closed 'electron exited'
}

# ── scenario: harness page cannot reach the desktop IPC ─────────────────────
function Test-IpcGate {
  ''
  '=== scenario: harness page IPC gate ==='
  $app = Start-App @('--workspace', $testWsA) $testHome
  if (-not (Wait-AppLog 'state: ready' 180)) { Add-Check 'ipc:initial-ready' $false 'timeout'; $null = Close-App; return }
  node $driver probe-harness-ipc "$root\.verify-v11-ipc.json" 2>&1 | Out-Null
  $probe = Get-Content "$root\.verify-v11-ipc.json" -Raw | ConvertFrom-Json
  foreach ($name in @('restart', 'backToWorkspaces', 'getLogs', 'copyLogs')) {
    $value = $probe.$name
    Add-Check "ipc:$name-rejected" ($value -like 'REJECTED:*') $value
  }
  $closed = Close-App
  Add-Check 'ipc:clean-quit' $closed 'electron exited'
}

# ── scenario: recents mini regression (remove + missing badge) ──────────────
function Test-RecentsMini {
  ''
  '=== scenario: recents mini regression ==='
  $recentsFile = Join-Path $userData 'recent-workspaces.json'
  $seed = @(
    @{ path = $testWsA; lastOpenedAt = 1786000000000 },
    @{ path = 'D:\does-not-exist-folder-xyz'; lastOpenedAt = 1785000000000 }
  ) | ConvertTo-Json
  Set-Content -Path $recentsFile -Value $seed -Encoding utf8
  $app = Start-App @() $null
  Start-Sleep -Seconds 6
  node (Join-Path $root 'scripts\verify-recents.mjs') dump 2>&1 | Out-Null
  $dump = Get-Content "$root\.verify-recents-dump.txt" -Raw -ErrorAction SilentlyContinue
  Add-Check 'recents:missing-badge' ($dump -match '\(missing\)') 'missing badge rendered'
  node (Join-Path $root 'scripts\verify-recents.mjs') remove-missing 2>&1 | Out-Null
  Start-Sleep -Seconds 1
  $after = Get-Content "$root\.verify-recents-after-remove.txt" -Raw -ErrorAction SilentlyContinue
  Add-Check 'recents:remove-works' ($after.Contains($testWsA) -and -not $after.Contains('does-not-exist')) 'missing entry removed, existing one kept'
  $closed = Close-App
  Add-Check 'recents:clean-quit' $closed 'electron exited'
  Remove-Item $recentsFile -Force -ErrorAction SilentlyContinue
}

# ── runner ──────────────────────────────────────────────────────────────────
switch ($Scenario) {
  'crash' { Test-CrashRecovery }
  'disconnect' { Test-HttpDisconnect }
  'back' { Test-BackToWorkspaces }
  'window' { Test-WindowState }
  'logs' { Test-Logs }
  'single' { Test-SingleInstance }
  'ipc' { Test-IpcGate }
  'recents' { Test-RecentsMini }
  'all' {
    Test-CrashRecovery
    Test-HttpDisconnect
    Test-BackToWorkspaces
    Test-WindowState
    Test-Logs
    Test-SingleInstance
    Test-IpcGate
    Test-RecentsMini
  }
  default { throw "unknown scenario: $Scenario" }
}

''
'=== V1.1 reliability results ==='
$passed = 0; $failed = 0
foreach ($r in $script:Results) {
  "[{0}] {1}  {2}" -f ($(if ($r.Pass) { 'PASS' } else { 'FAIL' }), $r.Name, $r.Evidence)
  if ($r.Pass) { $passed++ } else { $failed++ }
}
"TOTAL: $($passed + $failed) checks, $passed PASS, $failed FAIL"
if ($failed -gt 0) { exit 1 } else { exit 0 }
