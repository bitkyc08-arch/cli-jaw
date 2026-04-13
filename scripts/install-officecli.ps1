param(
  [switch]$Force,
  [switch]$Update,
  [switch]$Upstream,
  [string]$Repo = $env:OFFICECLI_REPO
)

$ErrorActionPreference = "Stop"

function Write-Info($msg) { Write-Host "▸ $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "✔ $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "⚠ $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "✖ $msg" -ForegroundColor Red; exit 1 }

if ($Upstream -and $env:OFFICECLI_REPO) {
  Fail "--upstream cannot be combined with OFFICECLI_REPO"
}

if (-not $Repo) {
  $Repo = "lidge-jun/OfficeCLI"
}
if ($Upstream) {
  $Repo = "iOfficeAI/OfficeCLI"
}

$installDir = Join-Path $env:LOCALAPPDATA "OfficeCli"
$targetBin = Join-Path $installDir "officecli.exe"
$downloadBin = Join-Path $installDir "officecli.download.exe"

$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
switch ($arch) {
  "x64" { $asset = "officecli-win-x64.exe" }
  "arm64" { $asset = "officecli-win-arm64.exe" }
  default { Fail "Unsupported Windows architecture: $arch" }
}

function Normalize-Version([string]$version) {
  if (-not $version) { return "" }
  return $version.Trim().TrimStart('v')
}

function Get-LatestTag([string]$repoName) {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repoName/releases/latest" -Headers @{ "User-Agent" = "cli-jaw-postinstall" }
  return [string]$release.tag_name
}

Write-Info "Platform: win32/$arch -> $asset"

if ((Test-Path $targetBin) -and -not $Force -and -not $Update) {
  try {
    $current = & $targetBin --version 2>$null
    Write-Ok "officecli already installed: v$($current.Trim())"
    Write-Host "  Use -Force to reinstall or -Update to refresh only when outdated"
    exit 0
  } catch {
    Write-Warn "Existing officecli is not executable; reinstalling"
  }
}

if ((Test-Path $targetBin) -and -not $Force -and $Update) {
  $current = ""
  $latest = ""
  try { $current = & $targetBin --version 2>$null } catch { }
  try { $latest = Get-LatestTag $Repo } catch { }
  if ($current -and $latest -and (Normalize-Version $current) -eq (Normalize-Version $latest)) {
    Write-Ok "officecli already up to date: v$(Normalize-Version $current)"
    exit 0
  }
  if ($current -and $latest) {
    Write-Info "Updating officecli v$(Normalize-Version $current) -> v$(Normalize-Version $latest)"
  } else {
    Write-Warn "Could not compare installed version with latest release; reinstalling"
  }
}

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$downloadUrl = "https://github.com/$Repo/releases/latest/download/$asset"

Write-Info "Downloading officecli from $Repo..."
Invoke-WebRequest -Uri $downloadUrl -OutFile $downloadBin

try {
  $version = (& $downloadBin --version 2>$null).Trim()
} catch {
  Remove-Item -Force $downloadBin -ErrorAction SilentlyContinue
  Fail "Binary exists but won't execute"
}

Move-Item -Force $downloadBin $targetBin
Write-Ok "officecli v$version installed -> $targetBin"

$pathEntries = (($env:PATH -split ';') | ForEach-Object { $_.Trim() }) | Where-Object { $_ }
if (-not ($pathEntries -contains $installDir)) {
  Write-Warn "officecli is not on PATH. Add this location if you want to run it directly:"
  Write-Host "  $installDir"
}
