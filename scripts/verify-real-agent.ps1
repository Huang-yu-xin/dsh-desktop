# Real-agent verification orchestration.
#   agent   : launch the app with the credential env inherited from the
#             running harness (its own env-based credential mechanism),
#             drive the UI through CDP, verify the read-only task, close.
#   persist : relaunch the same workspace and verify session persistence.
param([ValidateSet('agent', 'persist')][string]$Mode = 'agent', [string]$ExePath = '')
$ErrorActionPreference = 'Stop'
$root = 'D:\software\dsh-desktop'
$workspace = 'D:\software'
$appLog = Join-Path $env:APPDATA 'dsh-desktop\dsh-desktop.log'
# DEV default: the Electron binary from the project tree. PACKAGED runs pass
# -ExePath pointing at the built/installed "DeepSeek Harness Desktop.exe".
$electronExe = if ($ExePath) { $ExePath } else { Join-Path $root 'node_modules\electron\dist\electron.exe' }
$AppProcName = [System.IO.Path]::GetFileNameWithoutExtension($electronExe)

# ---- process environment block reader (reads ONLY the real env block:
#      terminates at the empty-entry marker, never touches adjacent memory) ----
Add-Type -TypeDefinition ([System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'envreader.cs.txt')))

function Wait-AppLog([string]$Pattern, [int]$TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    Start-Sleep -Milliseconds 500
    $text = if (Test-Path $appLog) { [System.IO.File]::ReadAllText($appLog) } else { '' }
  } while ($text -notmatch $Pattern -and (Get-Date) -lt $deadline)
  return $text
}

function Close-AppWindow {
  $proc = Get-Process -Name $AppProcName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($proc) { $null = $proc.CloseMainWindow(); return $true }
  return $false
}

function Wait-ElectronExit([int]$TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do { Start-Sleep -Milliseconds 500; $still = @(Get-Process -Name $AppProcName -ErrorAction SilentlyContinue) } while ($still.Count -gt 0 -and (Get-Date) -lt $deadline)
  return $still.Count -eq 0
}

# ---- inherit credentials the way the running harness uses them: its own env ----
$harnessPid = (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
$inherited = @()
if ($harnessPid) {
  $envMap = [NativeEnvRow]::Read([int]$harnessPid)
  foreach ($name in @('DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL')) {
    if ($envMap.ContainsKey($name)) {
      Set-Item -Path "Env:$name" -Value $envMap[$name]
      $inherited += $name
    }
  }
}
"inherited credential env (names only): $($inherited -join ', ')"
if ($inherited -notcontains 'DEEPSEEK_API_KEY') { 'RESULT: FAILURES PRESENT (no DEEPSEEK_API_KEY in the running harness env)'; exit 1 }

# Clean launch environment for the desktop app.
Remove-Item Env:\DSH_SESSION_JSONL, Env:\DSH_SESSION_ID, Env:\DSH_WEB_URL, Env:\DSH_SHELL, Env:\DSH_DESKTOP_SHOT -ErrorAction SilentlyContinue

if ($Mode -eq 'agent') {
  $hashBefore = Join-Path $root '.verify-hash-before.json'
  $files = Get-ChildItem $root -Recurse -File | Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\|\.verify-|\\\.git\\' }
  $snapshot = $files | ForEach-Object { [pscustomobject]@{ Path = $_.FullName.Substring($root.Length + 1); Hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash } }
  $snapshot | ConvertTo-Json | Set-Content $hashBefore
  "hash snapshot: $($files.Count) files"
}

Remove-Item $appLog -Force -ErrorAction SilentlyContinue
if ($Mode -eq 'agent') {
  Remove-Item "$root\.verify-agent-result.json", "$root\.verify-persist-result.json" -Force -ErrorAction SilentlyContinue
}

# ---- launch the desktop app (real DSH_HOME, real workspace, CDP open) ----
# The app-path '.' argument is for DEV electron runs only; the packaged exe
# takes no app-path argument.
$launchArgs = if ($ExePath) { @('--workspace', $workspace, '--remote-debugging-port=9333') } else { @('.', '--workspace', $workspace, '--remote-debugging-port=9333') }
$p = Start-Process -FilePath $electronExe -ArgumentList $launchArgs -WorkingDirectory $root -PassThru
"app pid=$($p.Id) mode=$Mode"
$null = Wait-AppLog 'state: ready' 180
$appState = if (Test-Path $appLog) { [System.IO.File]::ReadAllText($appLog) } else { '' }
if ($appState -notmatch 'state: ready') { "app state: FAILED"; Get-Content $appLog -Tail 20 -ErrorAction SilentlyContinue; exit 1 }
"app state: ready"

# ---- drive the UI ----
node (Join-Path $root 'scripts\verify-agent.mjs') $Mode
$driverExit = $LASTEXITCODE
"driver exit: $driverExit"

if ($Mode -eq 'agent' -and $driverExit -eq 0) {
  $result = Get-Content (Join-Path $root '.verify-agent-result.json') -Raw | ConvertFrom-Json
  "session: $($result.sessionDir)"
  "session file: $($result.sessionFile)"
  "prompt in log: $($result.promptFound)"
  "title: $($result.title)"
  "tools used: $($result.toolNames -join ', ')"
  "tool errors: $($result.isErrorCount)"
  # read-only classifier: only read/list/search/task-tracking tools are expected
  $writey = $result.toolNames | Where-Object { $_ -notmatch '^(glob|read|pwsh|todo|fs)' }
  "non-read-only tools: $(if ($writey) { $writey -join ', ' } else { 'none' })"
  # hash compare
  $hashAfter = Join-Path $root '.verify-hash-after.json'
  $files2 = Get-ChildItem $root -Recurse -File | Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\|\.verify-|\\\.git\\' }
  $snapshot2 = $files2 | ForEach-Object { [pscustomobject]@{ Path = $_.FullName.Substring($root.Length + 1); Hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash } }
  $snapshot2 | ConvertTo-Json | Set-Content $hashAfter
  $before = Get-Content (Join-Path $root '.verify-hash-before.json') -Raw | ConvertFrom-Json
  $changed = @()
  foreach ($b in $before) {
    $a = $snapshot2 | Where-Object { $_.Path -eq $b.Path } | Select-Object -First 1
    if (-not $a -or $a.Hash -ne $b.Hash) { $changed += $b.Path }
  }
  $added = @($snapshot2 | Where-Object { $_.Path -notin $before.Path })
  "workspace files changed: $(if ($changed) { $changed -join ', ' } else { 'none' })"
  "workspace files added: $(if ($added) { $added -join ', ' } else { 'none' })"
  $uiDump = Join-Path $root '.verify-ui-final-dump.txt'
  if (Test-Path $uiDump) { "final UI text length: $((Get-Content $uiDump -Raw).Length)" }
}

if ($Mode -eq 'persist' -and $driverExit -eq 0) {
  Get-Content (Join-Path $root '.verify-persist-result.json') -Raw
}

# ---- clean close ----
$closed = Close-AppWindow
"window close sent: $closed"
$exited = Wait-ElectronExit 30
"electron exited: $exited"
if (Test-Path $appLog) {
  $logText = [System.IO.File]::ReadAllText($appLog)
  if ($logText -match 'harness spawned: pid=(\d+)') {
    $hp = [int]$Matches[1]
    "harness pid gone: $(-not [bool](Get-Process -Id $hp -ErrorAction SilentlyContinue))"
  }
}
if ($driverExit -eq 0) { 'RESULT: DRIVER PASSED' } else { 'RESULT: DRIVER FAILED' }
exit $driverExit
