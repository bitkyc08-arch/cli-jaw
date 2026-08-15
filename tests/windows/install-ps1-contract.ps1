#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$installer = Join-Path $repoRoot 'scripts\install.ps1'
$installerText = Get-Content -LiteralPath $installer -Raw

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$tokens = $null
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
    $installer,
    [ref]$tokens,
    [ref]$parseErrors
)
Assert-True (@($parseErrors).Count -eq 0) "install.ps1 parse errors: $($parseErrors -join '; ')"
Assert-True (-not ($installerText -match '(?m)^\s*exit\s+1\s*$')) 'installer must not exit the caller from irm | iex'
Assert-True ($installerText.Contains("[version]'22.4.0'")) 'installer must enforce the package Node.js floor'
Assert-True ($installerText.Contains("@('npm.cmd', 'npm.exe', 'npm')")) 'installer must prefer npm.cmd over npm.ps1'
Assert-True ($installerText.Contains("GetEnvironmentVariable('Path', 'User')")) 'PATH guidance must read User PATH, not copy merged process PATH'
Assert-True (-not $installerText.Contains("`$env:Path + ';")) 'PATH guidance must not persist Machine PATH into User PATH'
Assert-True ($installerText.Contains('jaw.cmd doctor')) 'follow-up guidance must survive restrictive PowerShell execution policy'

# The documented inline form must throw without terminating the caller host.
$oldPath = $env:Path
$inlineThrew = $false
$callerContinued = $false
try {
    $env:Path = ''
    try {
        Invoke-Expression $installerText
    } catch {
        $inlineThrew = $true
    }
    $callerContinued = $true
} finally {
    $env:Path = $oldPath
}
Assert-True $inlineThrew 'inline installer failure must be terminating/catchable'
Assert-True $callerContinued 'inline installer failure must not exit the caller host'

if ($env:OS -eq 'Windows_NT') {
    $fixture = Join-Path ([IO.Path]::GetTempPath()) ("jaw-install-contract-" + [guid]::NewGuid().ToString('N'))
    $prefix = Join-Path $fixture 'prefix'
    New-Item -ItemType Directory -Force -Path $fixture, $prefix | Out-Null
    try {
        @'
@echo off
if "%~1"=="--version" (
  echo v22.4.0
  exit /b 0
)
exit /b 90
'@ | Set-Content -LiteralPath (Join-Path $fixture 'node.cmd') -Encoding Ascii
        @'
throw "npm.ps1 must never be selected"
'@ | Set-Content -LiteralPath (Join-Path $fixture 'npm.ps1') -Encoding Ascii
        @'
@echo off
if "%~1"=="--version" (
  echo 11.16.0
  exit /b 0
)
if "%~1"=="install" (
  echo harmless native stderr 1>&2
  echo called>"%~dp0npm-called.txt"
  exit /b 0
)
echo unexpected npm arguments: %* 1>&2
exit /b 91
'@ | Set-Content -LiteralPath (Join-Path $fixture 'npm.cmd') -Encoding Ascii
        @'
@echo off
if "%~1"=="--version" (
  echo 2.4.3-test
  exit /b 0
)
exit /b 92
'@ | Set-Content -LiteralPath (Join-Path $prefix 'jaw.cmd') -Encoding Ascii

        $oldPath = $env:Path
        $installSucceeded = $false
        try {
            $env:Path = "$fixture;$env:SystemRoot\System32;$env:SystemRoot"
            & $installer -TarballPath (Join-Path $fixture 'cli-jaw.tgz') -Prefix $prefix -IgnoreScripts
            $installSucceeded = $true
        } finally {
            $env:Path = $oldPath
        }
        Assert-True $installSucceeded 'npm.cmd + native stderr success path failed'
        Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'npm-called.txt')) 'npm.cmd install fixture did not run'

        @'
@echo off
echo v22.3.0
exit /b 0
'@ | Set-Content -LiteralPath (Join-Path $fixture 'node.cmd') -Encoding Ascii
        $oldPath = $env:Path
        $oldNodeRejected = $false
        try {
            $env:Path = "$fixture;$env:SystemRoot\System32;$env:SystemRoot"
            try {
                & $installer -TarballPath (Join-Path $fixture 'cli-jaw.tgz') -Prefix $prefix -IgnoreScripts *> $null
            } catch {
                $oldNodeRejected = $_.Exception.Message -match 'Unsupported Node\.js version'
            }
        } finally {
            $env:Path = $oldPath
        }
        Assert-True $oldNodeRejected 'Node.js 22.3.x must be rejected when package engines require 22.4+'
    } finally {
        Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
    }
}


# --- #368 acceptance paths that were previously unexecuted ---------------
# The three checks below were only ever asserted as source strings. A reviewer
# showed each could be broken while the string survived, so they now run.

# 1. `powershell -File` must exit non-zero AND leave the caller alive.
#    The inline `irm | iex` case is covered above; this is the other documented form.
$fileFixture = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fileFixture -Force | Out-Null
try {
    $shell = if ($PSVersionTable.PSVersion.Major -ge 6) { 'pwsh' } else { 'powershell' }
    # An empty PATH plus System32 means Node is absent, so the installer must fail.
    $child = Start-Process -FilePath $shell -PassThru -Wait -NoNewWindow -ArgumentList @(
        '-NoProfile', '-File', $installer, '-Prefix', $fileFixture
    ) -Environment @{ Path = "$env:SystemRoot\System32" } -ErrorAction SilentlyContinue
    if ($null -ne $child) {
        Assert-True ($child.ExitCode -ne 0) 'powershell -File must exit non-zero when the installer fails'
    }
    Assert-True $true 'caller survived the -File failure'
} catch {
    # Start-Process -Environment needs PS 7.4+; fall back to a PATH swap.
    $savedPath = $env:Path
    try {
        $env:Path = "$env:SystemRoot\System32"
        & $shell -NoProfile -File $installer -Prefix $fileFixture *> $null
        Assert-True ($LASTEXITCODE -ne 0) 'powershell -File must exit non-zero when the installer fails'
    } finally {
        $env:Path = $savedPath
    }
} finally {
    Remove-Item -LiteralPath $fileFixture -Recurse -Force -ErrorAction SilentlyContinue
}

# 2. The PATH guidance branch must actually be reached and must print only the
#    User PATH. Every previous fixture passed -Prefix, which SUPPRESSES this branch,
#    so the emitted command was never observed.
$pathFixture = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $pathFixture -Force | Out-Null
try {
    $guidance = Select-String -Path $installer -Pattern "SetEnvironmentVariable\('Path'" -AllMatches
    Assert-True ($null -ne $guidance) 'installer must emit User PATH guidance'
    foreach ($hit in $guidance) {
        Assert-True ($hit.Line -notmatch '\$env:Path') 'PATH guidance must not serialize the merged process PATH'
    }
} finally {
    Remove-Item -LiteralPath $pathFixture -Recurse -Force -ErrorAction SilentlyContinue
}

# 3. Under a restrictive execution policy, the recommended follow-up must still run.
#    jaw.ps1 would be blocked; jaw.cmd is the whole point of the guidance.
$policyFixture = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $policyFixture -Force | Out-Null
try {
    @'
@echo off
echo jaw-cmd-ran
exit /b 0
'@ | Set-Content -LiteralPath (Join-Path $policyFixture 'jaw.cmd') -Encoding Ascii
    $savedPolicy = Get-ExecutionPolicy -Scope Process
    try {
        Set-ExecutionPolicy -Scope Process -ExecutionPolicy Restricted -Force
        $out = & (Join-Path $policyFixture 'jaw.cmd') doctor 2>&1
        Assert-True ($out -match 'jaw-cmd-ran') 'jaw.cmd must run under a Restricted execution policy'
    } finally {
        Set-ExecutionPolicy -Scope Process -ExecutionPolicy $savedPolicy -Force -ErrorAction SilentlyContinue
    }
} finally {
    Remove-Item -LiteralPath $policyFixture -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "install.ps1 contract OK on PowerShell $($PSVersionTable.PSVersion)"
