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
    [switch]$IgnoreScripts,

    # Provision a pinned, hash-verified Node (and PortableGit) under LOCALAPPDATA
    # when the system lacks a supported one. OFF by default: see #369.
    [switch]$BootstrapDependencies,

    # Also provision PortableGit, which unlike MinGit ships bash.
    [switch]$WithPortableGit,

    # Print the full plan (urls, digests, targets, PATH delta) and exit without
    # touching disk. This is the enterprise-review surface #369 asks for.
    [switch]$DryRun
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


# --- Optional dependency bootstrap (#369) --------------------------------
# OFF by default. Enabling silent runtime downloads in a command users paste from
# a README is a product decision that cannot be walked back per-user, so the
# mechanism ships behind an explicit switch and the default installer behavior is
# unchanged. Planning/verification logic lives in src/core/windows-bootstrap.ts
# so it is unit-tested off-Windows; this function owns only the transaction.
function Get-BootstrapManifest {
    $manifestPath = Join-Path $PSScriptRoot 'windows-bootstrap-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) {
        Stop-Install "bootstrap manifest not found: $manifestPath"
    }
    return Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
}

function Resolve-NativeArch {
    # NATIVE architecture, not the process one: an ARM64 host can run x64
    # PowerShell under emulation, and PROCESSOR_ARCHITECTURE would then lie.
    $osArch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    switch ($osArch.ToLowerInvariant()) {
        'x64'   { return 'x64' }
        'arm64' { return 'arm64' }
        default { Stop-Install "unsupported Windows architecture: $osArch" }
    }
}

function Install-BootstrapTool([string]$Tool, [switch]$DryRunOnly) {
    $manifest = Get-BootstrapManifest
    $arch = Resolve-NativeArch
    $entry = $manifest.$Tool
    $artifact = $entry.artifacts.$arch
    if (-not $artifact) { Stop-Install "$Tool has no pinned artifact for $arch" }

    $url = $entry.urlTemplate.
        Replace('{version}', $entry.version).
        Replace('{tag}', $entry.tag).
        Replace('{arch}', $arch).
        Replace('{file}', $artifact.file)
    $installDir = Join-Path $env:LOCALAPPDATA "cli-jaw\runtimes\$Tool\$($entry.version)\$arch"

    if ($DryRunOnly) {
        Write-Info "[dry-run] $Tool $($entry.version) ($arch)"
        Write-Info "[dry-run]   url:    $url"
        Write-Info "[dry-run]   sha256: $($artifact.sha256)"
        Write-Info "[dry-run]   target: $installDir"
        return $null
    }

    # Already provisioned and probed? Re-running must be a no-op.
    $receiptPath = Join-Path $installDir 'cli-jaw-receipt.json'
    if (Test-Path -LiteralPath $receiptPath) {
        Write-Ok "$Tool $($entry.version) already provisioned"
        return $installDir
    }

    # Stage on the SAME volume so the promotion below is a rename, not a copy.
    $staging = Join-Path $env:LOCALAPPDATA "cli-jaw\.staging-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    try {
        $archive = Join-Path $staging $artifact.file
        Write-Info "Downloading $($artifact.file)..."
        Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing

        # HASH BEFORE EXTRACT. Verifying after extraction would already have run
        # attacker-controlled bytes through an archive parser.
        $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
        if ($actual -ine $artifact.sha256) {
            Stop-Install "$Tool checksum mismatch: expected $($artifact.sha256), got $actual"
        }
        Write-Ok "verified $($artifact.file)"

        $extracted = Join-Path $staging 'unpacked'
        New-Item -ItemType Directory -Path $extracted -Force | Out-Null
        if ($artifact.file -like '*.zip') {
            Expand-Archive -LiteralPath $archive -DestinationPath $extracted -Force
            # Node zips contain a single versioned top-level directory.
            $inner = @(Get-ChildItem -LiteralPath $extracted -Directory)
            if ($inner.Count -eq 1) { $extracted = $inner[0].FullName }
        } else {
            # PortableGit ships a self-extracting 7z archive.
            $seExit = Invoke-NativeStreaming $archive @('-o', $extracted, '-y')
            if ($seExit -ne 0) { Stop-Install "$Tool extraction failed (exit $seExit)" }
        }

        # Probe BEFORE promoting: a half-extracted tree must never be published.
        $probe = if ($Tool -eq 'node') { Join-Path $extracted 'node.exe' } else { Join-Path $extracted 'cmd\git.exe' }
        if (-not (Test-Path -LiteralPath $probe)) {
            Stop-Install "$Tool extraction did not produce the expected binary: $probe"
        }
        # EXECUTE it. Existence alone would promote a corrupt, truncated, or
        # wrong-architecture binary and then write a receipt calling it complete.
        $probeRun = Invoke-NativeCapture $probe @('--version')
        if ($probeRun.ExitCode -ne 0) {
            Stop-Install "$Tool binary failed to execute (exit $($probeRun.ExitCode)): $probe"
        }

        New-Item -ItemType Directory -Path (Split-Path -Parent $installDir) -Force | Out-Null
        if (Test-Path -LiteralPath $installDir) {
            # A previous run crashed between promotion and receipt. The tree has no
            # receipt, so it is unproven — discard rather than trust it.
            Remove-Item -LiteralPath $installDir -Recurse -Force
        }
        Move-Item -LiteralPath $extracted -Destination $installDir

        # Receipt LAST, and only after the probe: its presence is what marks the
        # install complete, so it must never exist for a partial tree.
        [pscustomobject]@{
            tool = $Tool; version = $entry.version; arch = $arch
            installDir = $installDir; sha256 = $artifact.sha256; url = $url
            installedAt = (Get-Date).ToUniversalTime().ToString('o')
        } | ConvertTo-Json | Set-Content -LiteralPath "$receiptPath.tmp" -Encoding UTF8
        # Atomic publish: a crash mid-write must not leave a partial receipt that a
        # later run would trust as proof of a complete install.
        Move-Item -LiteralPath "$receiptPath.tmp" -Destination $receiptPath -Force
        Write-Ok "$Tool $($entry.version) installed to $installDir"
        return $installDir
    } finally {
        # Any failure leaves no half-claimed install: staging always goes away.
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# --- 1. Node.js >= 22.4 --------------------------------------------------
$nodePath = Resolve-CommandPath @('node.exe', 'node')
if (-not $nodePath) {
    if ($BootstrapDependencies -or $DryRun) {
        Write-Info 'Node.js not found — provisioning a pinned runtime (#369).'
        $nodeDir = Install-BootstrapTool -Tool 'node' -DryRunOnly:$DryRun
        if ($WithPortableGit -or $DryRun) {
            Install-BootstrapTool -Tool 'git' -DryRunOnly:$DryRun | Out-Null
        }
        if ($DryRun) {
            Write-Info '[dry-run] no files were written.'
            return
        }
        # Current process only; User PATH persistence is printed, never forced.
        $env:Path = "$nodeDir;$env:Path"
        $nodePath = Resolve-CommandPath @('node.exe', 'node')
        if (-not $nodePath) { Stop-Install 'bootstrap completed but node is still unresolvable.' }
    } else {
        Write-Warn2 'Node.js not found on PATH.'
        Write-Warn2 'Install it first, then re-run this script:'
        Write-Warn2 '  winget install OpenJS.NodeJS.LTS'
        Write-Warn2 'Or provision a pinned runtime automatically (download first —'
        Write-Warn2 'the streamed form cannot take parameters, and bootstrap needs'
        Write-Warn2 'windows-bootstrap-manifest.json beside the script):'
        Write-Warn2 '  git clone --depth 1 https://github.com/lidge-jun/cli-jaw'
        Write-Warn2 '  .\\cli-jaw\\scripts\\install.ps1 -BootstrapDependencies'
        Stop-Install 'Node.js 22.4.0 or newer is required.'
    }
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

if ($DryRun) {
    # -DryRun promises to touch nothing. Without this guard a machine that ALREADY
    # has Node would fall through to a real 'npm install -g'.
    Write-Info '[dry-run] node present; no bootstrap needed.'
    Write-Info '[dry-run] would install cli-jaw globally with npm.'
    Write-Info '[dry-run] no files were written.'
    return
}

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
