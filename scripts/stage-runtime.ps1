# Stage the exact production dependency tree for packaging.
# electron-builder's own dependency collector mis-prunes this npm 11 lockfile
# graph, so the runtime tree is assembled here with the OFFICIAL npm resolver
# and shipped via extraResources (resources/dsh-runtime/node_modules).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $root 'release-stage'
$manifest = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$dshVersion = $manifest.dependencies.'@deepseek-ai/dsh'
if (-not $dshVersion) { throw 'stage-runtime: @deepseek-ai/dsh is not a pinned production dependency' }

New-Item -ItemType Directory -Force -Path $stage | Out-Null
$stagePkg = @{
  name         = 'dsh-runtime-stage'
  private      = $true
  version      = '1.0.0'
  dependencies = @{ '@deepseek-ai/dsh' = $dshVersion }
}
$stagePkg | ConvertTo-Json | Set-Content (Join-Path $stage 'package.json') -Encoding utf8

"stage-runtime: installing @deepseek-ai/dsh@$dshVersion into $stage"
npm install --prefix $stage --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "stage-runtime: npm install failed (exit $LASTEXITCODE)" }

$bin = Join-Path $stage 'node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path $bin)) { throw "stage-runtime: staged tree is missing $bin" }
if (-not (Test-Path (Join-Path $stage 'node_modules\js-yaml'))) { throw 'stage-runtime: staged tree is missing js-yaml' }

# ── evidenced size trimming (every item is runtime-verifiable) ──────────────
# .pdb debug symbols (never loaded at runtime)
Get-ChildItem $stage -Recurse -File -Filter '*.pdb' | Remove-Item -Force
# non-win32-x64 node-pty prebuilds (win32-x64 only ships)
Get-ChildItem (Join-Path $stage 'node_modules\node-pty\prebuilds') -Directory | Where-Object { $_.Name -ne 'win32-x64' } | Remove-Item -Recurse -Force
# node-pty third_party build sources + build/ output (prebuilds are used)
Remove-Item (Join-Path $stage 'node_modules\node-pty\third_party') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $stage 'node_modules\node-pty\build') -Recurse -Force -ErrorAction SilentlyContinue
# @types/* are compile-time only
Get-ChildItem $stage -Recurse -Directory -Filter '@types' | Where-Object { $_.FullName -match '\\node_modules\\@types$' } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
"stage-runtime: OK $bin"
