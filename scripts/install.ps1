#Requires -Version 5.1
<#
.SYNOPSIS
  CLI-JAW one-click installer for native Windows (beta).

.DESCRIPTION
  Installs cli-jaw globally with npm, attaching --allow-scripts when the npm
  version supports it (npm >= 11.16; npm 12 blocks unreviewed dependency
  lifecycle scripts by default). Verifies PATH and the installed binary, and
  prints exact fixes instead of mutating user PATH or system policy.

  This script never changes the PowerShell execution policy, never requires
  elevation, and never edits the user PATH — it prints the command instead.

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
$MinimumNodeVersion = [version]'22.4.0'

function Write-Info([string]$Message) { Write-Host "  $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "  $Message" -ForegroundColor Green }
function Write-Warn2([string]$Message) { Write-Host "  $Message" -ForegroundColor Yellow }

function Stop-Install([string]$Message) {
    if ($Message) { Write-Warn2 $Message }
    # A terminating error makes `powershell -File` return non-zero without
    # killing the caller when the documented `irm ... | iex` form is used.
    throw "CLI-JAW installation failed. $Message"
}

function Resolve-CommandPath([string[]]$Candidates) {
    foreach ($candidate in $Candidates) {
        $command = Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($command) {
            if ($command.Path) { return $command.Path }
            if ($command.Source) { return $command.Source }
        }
    }
    return $null
}

function Invoke-NativeCapture([string]$CommandPath, [string[]]$Arguments = @()) {
    $previousErrorAction = $ErrorActionPreference
    $exitCode = 1
    $output = @()
    try {
        # Windows PowerShell 5.1 turns native stderr into NativeCommandError
        # records. Continue long enough to preserve the real native exit code.
        $ErrorActionPreference = 'Continue'
        $output = @(& $CommandPath @Arguments 2>&1 | ForEach-Object { "$_" })
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    return [pscustomobject]@{
        ExitCode = [int]$exitCode
        Output = $output
    }
}

function Invoke-NativeStreaming([string]$CommandPath, [string[]]$Arguments = @()) {
    $previousErrorAction = $ErrorActionPreference
    $exitCode = 1
    try {
        $ErrorActionPreference = 'Continue'
        & $CommandPath @Arguments 2>&1 | ForEach-Object { Write-Host "$_" }
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    return [int]$exitCode
}

function Get-FirstOutputLine($Probe) {
    $line = $Probe.Output | Where-Object { -not [string]::IsNullOrWhiteSpace("$_") } |
        Select-Object -First 1
    if ($null -eq $line) { return '' }
    return ("$line").Trim()
}

function Normalize-PathEntry([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    return ($Value.Trim() -replace '[\\/]+$', '')
}

try {
    $utf8NoBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
    [Console]::OutputEncoding = $utf8NoBom
    $OutputEncoding = $utf8NoBom
} catch {
    # Encoding setup is best-effort; command exit codes remain authoritative.
}

Write-Host ''
Write-Host '  CLI-JAW Windows Installer (beta)' -ForegroundColor Cyan
Write-Host ''

# --- 1. Node.js >= 22.4 --------------------------------------------------
$nodePath = Resolve-CommandPath @('node.exe', 'node')
if (-not $nodePath) {
    Write-Warn2 'Node.js not found on PATH.'
    Write-Warn2 'Install it first, then re-run this script:'
    Write-Warn2 '  winget install OpenJS.NodeJS.LTS'
    Stop-Install 'Node.js 22.4.0 or newer is required.'
}
$nodeProbe = Invoke-NativeCapture $nodePath @('--version')
if ($nodeProbe.ExitCode -ne 0) {
    Stop-Install "node --version failed (exit $($nodeProbe.ExitCode))."
}
$nodeVersionText = (Get-FirstOutputLine $nodeProbe) -replace '^v', ''
try {
    $nodeVersion = [version]$nodeVersionText
} catch {
    Stop-Install "Could not parse Node.js version: $nodeVersionText"
}
if ($nodeVersion -lt $MinimumNodeVersion) {
    Write-Warn2 "Node.js >= $MinimumNodeVersion required (current: v$nodeVersionText)."
    Write-Warn2 '  winget install OpenJS.NodeJS.LTS'
    Stop-Install 'Unsupported Node.js version.'
}
Write-Ok "Node.js v$nodeVersionText"

# --- 2. npm allow-scripts support ---------------------------------------
# Prefer npm.cmd so Restricted/RemoteSigned execution policy does not select
# and reject npm.ps1. npm >= 11.16 understands --allow-scripts; npm 12 blocks
# unreviewed dependency lifecycle scripts by default.
$npmPath = Resolve-CommandPath @('npm.cmd', 'npm.exe', 'npm')
if (-not $npmPath) {
    Stop-Install 'npm was not found on PATH. Reinstall Node.js, open a new terminal, and retry.'
}
$npmProbe = Invoke-NativeCapture $npmPath @('--version')
if ($npmProbe.ExitCode -ne 0) {
    Stop-Install "npm --version failed (exit $($npmProbe.ExitCode))."
}
$npmVersion = Get-FirstOutputLine $npmProbe
$npmParts = $npmVersion.Split('.')
if ($npmParts.Count -lt 2) {
    Stop-Install "Could not parse npm version: $npmVersion"
}
try {
    $npmMajor = [int]$npmParts[0]
    $npmMinor = [int]$npmParts[1]
} catch {
    Stop-Install "Could not parse npm version: $npmVersion"
}
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
$npmExitCode = Invoke-NativeStreaming $npmPath $npmArgs
if ($npmExitCode -ne 0) {
    Write-Warn2 "npm install failed (exit $npmExitCode)."
    Write-Warn2 'If the error mentions blocked install scripts, run:'
    Write-Warn2 "  npm.cmd install -g cli-jaw --allow-scripts=$JawAllowScripts"
    Stop-Install 'npm install did not complete.'
}

# --- 4. PATH check -------------------------------------------------------
if ($Prefix) {
    $globalBin = $Prefix
} else {
    $prefixProbe = Invoke-NativeCapture $npmPath @('prefix', '-g')
    if ($prefixProbe.ExitCode -ne 0) {
        Stop-Install "npm prefix -g failed (exit $($prefixProbe.ExitCode))."
    }
    $globalBin = Get-FirstOutputLine $prefixProbe
}
if ([string]::IsNullOrWhiteSpace($globalBin)) {
    Stop-Install 'npm returned an empty global prefix.'
}
$normalizedGlobalBin = Normalize-PathEntry $globalBin
$onPath = @(([string]$env:Path -split ';') | Where-Object {
    (Normalize-PathEntry "$_") -ieq $normalizedGlobalBin
}).Count -gt 0
if (-not $onPath -and -not $Prefix) {
    $escapedGlobalBin = $globalBin.Replace("'", "''")
    Write-Warn2 "npm global bin dir is not on PATH: $globalBin"
    Write-Warn2 'Add it for the current user (then open a new terminal):'
    Write-Warn2 "  `$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')"
    Write-Warn2 "  if (-not ((`$userPath -split ';') -contains '$escapedGlobalBin')) {"
    Write-Warn2 "      `$entries = @(`$userPath -split ';' | Where-Object { `$_ }) + '$escapedGlobalBin'"
    Write-Warn2 "      [Environment]::SetEnvironmentVariable('Path', (`$entries -join ';'), 'User')"
    Write-Warn2 '  }'
}

# --- 5. Verify -----------------------------------------------------------
$jawCmd = Join-Path $globalBin 'jaw.cmd'
if (-not (Test-Path -LiteralPath $jawCmd -PathType Leaf)) {
    $jawCmd = Resolve-CommandPath @('jaw.cmd', 'jaw.exe')
}
if ($jawCmd -and (Test-Path -LiteralPath $jawCmd -PathType Leaf)) {
    $jawProbe = Invoke-NativeCapture $jawCmd @('--version')
    if ($jawProbe.ExitCode -ne 0) {
        Stop-Install "jaw.cmd --version failed (exit $($jawProbe.ExitCode))."
    }
    $jawVersion = Get-FirstOutputLine $jawProbe
    Write-Ok "cli-jaw installed: $jawVersion"
    Write-Info 'Next: jaw.cmd doctor  (diagnose)  |  jaw.cmd init  (finish setup)'
} else {
    Write-Warn2 'Install finished but jaw.cmd was not found.'
    Write-Warn2 'Diagnose with: npm.cmd ls -g cli-jaw ; then check the PATH note above.'
    Stop-Install 'Installed command verification failed.'
}
