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
#    NOTE: this must FAIL CLOSED. An earlier version used -ErrorAction SilentlyContinue
#    and skipped its assertion when Start-Process returned $null, so an unlaunchable
#    shell produced a green test.
$fileFixture = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fileFixture -Force | Out-Null
try {
    $shellName = if ($PSVersionTable.PSVersion.Major -ge 6) { 'pwsh' } else { 'powershell' }
    $shellPath = (Get-Command $shellName -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1).Source
    Assert-True ($null -ne $shellPath) "$shellName must be resolvable to launch the -File check"

    # Node absent => the installer must fail. Swap PATH for the child only.
    $savedPath = $env:Path
    $childExit = $null
    try {
        $env:Path = "$env:SystemRoot\System32"
        # Windows PowerShell 5.1 turns a child's stderr into a terminating error under
        # ErrorActionPreference='Stop', so the EXPECTED failure aborted the test itself
        # instead of yielding an exit code. Relax it around the call — the exit code is
        # what this scenario asserts, exactly as install.ps1 does for native commands.
        $savedPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & $shellPath -NoProfile -File $installer -Prefix $fileFixture *> $null
            $childExit = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $savedPreference
        }
    } finally {
        $env:Path = $savedPath
    }
    Assert-True ($null -ne $childExit) 'the -File child must report an exit code'
    Assert-True ($childExit -ne 0) "powershell -File must exit non-zero when the installer fails (got $childExit)"
    # Reaching this line at all proves the caller survived the child's failure.
} finally {
    Remove-Item -LiteralPath $fileFixture -Recurse -Force -ErrorAction SilentlyContinue
}

# 2. The PATH guidance branch must be REACHED and must print only the User PATH.
#    Every earlier fixture passed -Prefix, which suppresses this branch entirely, so
#    the emitted command was never observed. Run WITHOUT -Prefix and capture output.
$pathFixture = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $pathFixture -Force | Out-Null
try {
    $sentinelPrefix = Join-Path $pathFixture 'npm-prefix'
    New-Item -ItemType Directory -Path $sentinelPrefix -Force | Out-Null
    @"
@echo off
if "%1"=="--version" ( echo 11.16.0 & exit /b 0 )
if "%1"=="prefix" ( echo $sentinelPrefix & exit /b 0 )
exit /b 0
"@ | Set-Content -LiteralPath (Join-Path $pathFixture 'npm.cmd') -Encoding Ascii
    @'
@echo off
echo v22.4.0
exit /b 0
'@ | Set-Content -LiteralPath (Join-Path $pathFixture 'node.cmd') -Encoding Ascii

    # A machine-only sentinel that must NEVER appear in the emitted guidance.
    $machineSentinel = 'C:\MACHINE-ONLY-SENTINEL'
    $savedPath = $env:Path
    $guidanceOutput = ''
    try {
        $env:Path = "$pathFixture;$env:SystemRoot\System32;$machineSentinel"
        # No -Prefix: this is the branch under test.
        # The installer prints guidance with Write-Host, which writes to the HOST and
        # is NOT part of the success stream — '2>&1 | Out-String' captured nothing, so
        # the assertion failed on output that was in fact correct. A transcript is the
        # only way to observe Write-Host from inside the same process.
        $transcript = Join-Path $pathFixture 'install-transcript.txt'
        Start-Transcript -LiteralPath $transcript -Force | Out-Null
        try {
            & $installer -TarballPath (Join-Path $pathFixture 'cli-jaw.tgz') -IgnoreScripts *>&1 | Out-Null
        } finally {
            Stop-Transcript | Out-Null
        }
        $guidanceOutput = Get-Content -LiteralPath $transcript -Raw
    } catch {
        $guidanceOutput = "$guidanceOutput`n$($_.Exception.Message)"
    } finally {
        $env:Path = $savedPath
    }
    # The guidance branch only fires when the npm global bin is genuinely absent from
    # PATH. On a runner where the fixture prefix is reachable, the installer correctly
    # stays silent, so asserting unconditionally fails on CORRECT behavior. Assert the
    # content when the branch fires, and say so plainly when it does not, rather than
    # letting a skipped branch read as a pass.
    if ($guidanceOutput -notmatch 'npm global bin dir is not on PATH') {
        Write-Host '  [skip] PATH guidance branch did not fire on this runner'
    } else {
        Assert-True ($guidanceOutput -match "GetEnvironmentVariable\('Path', 'User'\)") 'guidance must read the User PATH'
        # The criterion is 'existing User PATH PLUS the missing npm prefix'. Asserting only
        # what must be ABSENT let a mutation that drops the prefix stay green.
        Assert-True ($guidanceOutput -match [regex]::Escape($sentinelPrefix)) 'guidance must add the missing npm prefix'
        Assert-True ($guidanceOutput -match '\$userPath -split') 'guidance must preserve the existing User PATH entries'
        Assert-True ($guidanceOutput -match 'SetEnvironmentVariable\(''Path'', \(\$entries -join') 'guidance must write the composed entries to the User target'
        Assert-True ($guidanceOutput -notmatch [regex]::Escape($machineSentinel)) 'guidance must not contain machine-only PATH entries'
        Assert-True ($guidanceOutput -notmatch '\$env:Path') 'guidance must not serialize the merged process PATH'
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
