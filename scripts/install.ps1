#Requires -Version 5.1
<#
.SYNOPSIS
  CLI-JAW one-click installer for native Windows (beta).

.DESCRIPTION
  Installs cli-jaw globally with npm, attaching --allow-scripts when the npm
  version supports it (npm >= 11.16; npm 12 blocks unreviewed dependency
  lifecycle scripts by default). Verifies PATH and the installed binary, and
  prints exact fixes instead of mutating user PATH or system policy.

  This script never runs Set-ExecutionPolicy, never requires elevation, and
  never edits the user PATH — it prints the command to do so instead.

.PARAMETER TarballPath
  Install from a local .tgz produced by `npm pack` instead of the registry.
  Used by CI to validate the exact artifact that will ship.

.PARAMETER Prefix
  Use an isolated npm prefix instead of the default global prefix. Used by CI
  to avoid mutating the runner's real global tree.

.PARAMETER IgnoreScripts
  Pass --ignore-scripts to npm install. Used by CI to reproduce the
  blocked-postinstall scenario deliberately.

.EXAMPLE
  irm https://raw.githubusercontent.com/lidge-jun/cli-jaw/main/scripts/install.ps1 | iex
#>
[CmdletBinding()]
param(
    [string]$TarballPath = '',
    [string]$Prefix = '',
    [switch]$IgnoreScripts
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$JawAllowScripts = 'cli-jaw'

function Write-Info([string]$Message) { Write-Host "  $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "  $Message" -ForegroundColor Green }
function Write-Warn2([string]$Message) { Write-Host "  $Message" -ForegroundColor Yellow }

Write-Host ''
Write-Host '  CLI-JAW Windows Installer (beta)' -ForegroundColor Cyan
Write-Host ''

# --- 1. Node.js >= 22 ---------------------------------------------------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Warn2 'Node.js not found on PATH.'
    Write-Warn2 'Install it first, then re-run this script:'
    Write-Warn2 '  winget install OpenJS.NodeJS.LTS'
    exit 1
}
$nodeVersion = (& node --version) -replace '^v', ''
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 22) {
    Write-Warn2 "Node.js >= 22 required (current: v$nodeVersion)."
    Write-Warn2 '  winget install OpenJS.NodeJS.LTS'
    exit 1
}
Write-Ok "Node.js v$nodeVersion"

# --- 2. npm allow-scripts support ---------------------------------------
# npm >= 11.16 understands --allow-scripts; npm 12 blocks unreviewed
# dependency lifecycle scripts by default. Older npm rejects unknown config,
# so the flag is attached conditionally.
$npmVersion = (& npm --version).Trim()
$npmParts = $npmVersion.Split('.')
$npmMajor = [int]$npmParts[0]
$npmMinor = [int]$npmParts[1]
$supportsAllowScripts = ($npmMajor -gt 11) -or (($npmMajor -eq 11) -and ($npmMinor -ge 16))
Write-Ok "npm $npmVersion (allow-scripts: $supportsAllowScripts)"

# --- 3. Install ----------------------------------------------------------
$packageSpec = if ($TarballPath) { $TarballPath } else { 'cli-jaw' }
$npmArgs = @('install', '-g', $packageSpec)
if ($supportsAllowScripts -and -not $IgnoreScripts) {
    $npmArgs += "--allow-scripts=$JawAllowScripts"
}
if ($IgnoreScripts) { $npmArgs += '--ignore-scripts' }
if ($Prefix) { $npmArgs += @('--prefix', $Prefix) }

Write-Info "npm $($npmArgs -join ' ')"
& npm @npmArgs
if ($LASTEXITCODE -ne 0) {
    Write-Warn2 "npm install failed (exit $LASTEXITCODE)."
    Write-Warn2 'If the error mentions blocked install scripts, run:'
    Write-Warn2 "  npm install -g cli-jaw --allow-scripts=$JawAllowScripts"
    exit 1
}

# --- 4. PATH check --------------------------------------------------------
$globalBin = if ($Prefix) { $Prefix } else { (& npm prefix -g).Trim() }
$pathEntries = $env:Path -split ';'
$onPath = $pathEntries -contains $globalBin
if (-not $onPath -and -not $Prefix) {
    Write-Warn2 "npm global bin dir is not on PATH: $globalBin"
    Write-Warn2 'Add it for the current user (then open a new terminal):'
    Write-Warn2 "  [Environment]::SetEnvironmentVariable('Path', `$env:Path + ';$globalBin', 'User')"
}

# --- 5. Verify ------------------------------------------------------------
$jawCmd = Join-Path $globalBin 'jaw.cmd'
if (-not (Test-Path $jawCmd)) {
    # default-prefix installs may resolve via PATH instead
    $resolved = Get-Command jaw -ErrorAction SilentlyContinue
    if ($resolved) { $jawCmd = $resolved.Source }
}
if (Test-Path $jawCmd) {
    $jawVersion = (& $jawCmd --version)
    Write-Ok "cli-jaw installed: $jawVersion"
    Write-Info 'Next: jaw doctor  (diagnose)  |  jaw init  (finish setup)'
} else {
    Write-Warn2 'Install finished but the jaw command was not found.'
    Write-Warn2 'Diagnose with: npm ls -g cli-jaw ; then check the PATH note above.'
    exit 1
}
