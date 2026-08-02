# seed-wincodesign.ps1 — work around the winCodeSign extraction failure on Windows.
#
# THE PROBLEM: electron-builder needs the `winCodeSign-2.6.0` toolchain (rcedit +
# signtool) to write the app icon + version metadata into the exe (rcedit) and to
# sign (we don't sign, but rcedit still runs). It downloads winCodeSign-2.6.0.7z and
# extracts it into %LOCALAPPDATA%\electron-builder\Cache\winCodeSign\. That archive
# contains two macOS symlinks (darwin/10.12/lib/lib{crypto,ssl}.dylib). Extracting a
# symlink on Windows needs SeCreateSymbolicLinkPrivilege (Developer Mode or admin);
# without it 7-Zip returns exit code 2 and app-builder treats the whole extraction as
# failed — so it never renames the temp dir to the final `winCodeSign-2.6.0` and
# retries forever. The two dylibs are macOS-only and irrelevant to a Windows build.
#
# THE FIX: extract the archive ourselves with symlinks SKIPPED (7za -snld) straight
# into the final cache dir electron-builder looks for (`winCodeSign-2.6.0`). Once that
# dir exists with rcedit/signtool present, app-builder skips download+extract and the
# `dist` build proceeds. This is a one-time, per-machine seed (the cache persists).
#
# Usage (PowerShell):  ./scripts/seed-wincodesign.ps1
# Idempotent: re-running is a no-op if the seed dir already has rcedit-x64.exe.

$ErrorActionPreference = 'Stop'

$cacheRoot = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign'
$finalDir  = Join-Path $cacheRoot 'winCodeSign-2.6.0'
$rcedit    = Join-Path $finalDir 'rcedit-x64.exe'
$url       = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z'
$archive   = Join-Path $cacheRoot 'winCodeSign-2.6.0.7z'

# The 7za bundled with electron-builder (7zip-bin). Resolve relative to repo root.
$repoRoot = Split-Path -Parent $PSScriptRoot
$sevenZip = Join-Path $repoRoot 'node_modules\7zip-bin\win\x64\7za.exe'

if (Test-Path $rcedit) {
  Write-Host "winCodeSign already seeded at $finalDir (rcedit present) — nothing to do."
  exit 0
}

if (-not (Test-Path $sevenZip)) {
  throw "7za not found at $sevenZip — run 'npm install' first."
}

New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null

# Reuse an already-downloaded archive if present (a prior failed dist left one), else
# download it fresh.
if (-not (Test-Path $archive)) {
  # A failed run may have left a randomly-named copy; grab the first one.
  $existing = Get-ChildItem -Path $cacheRoot -Filter '*.7z' -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($existing) {
    Write-Host "Reusing cached archive $($existing.Name)"
    Copy-Item $existing.FullName $archive -Force
  } else {
    Write-Host "Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
  }
}

# Extract with symlinks skipped (-snld). 7za still tries the two dylib symlinks and
# exits non-zero (they can't be created), but every real file (rcedit, signtool, …)
# extracts fine — so we IGNORE the exit code and verify by checking for rcedit after.
# Temporarily drop $ErrorActionPreference so the native non-zero exit doesn't abort.
Write-Host "Extracting (skipping symlinks) into $finalDir"
if (Test-Path $finalDir) { Remove-Item $finalDir -Recurse -Force }
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $sevenZip x -snld -bd "-o$finalDir" $archive 2>$null | Out-Null
$ErrorActionPreference = $prevEAP

if (-not (Test-Path $rcedit)) {
  throw "Seed failed: $rcedit still missing after extraction."
}

Write-Host "Seeded winCodeSign at $finalDir"
Write-Host "rcedit-x64.exe present: $(Test-Path $rcedit)"
$signtool = Join-Path $finalDir 'windows-10\x64\signtool.exe'
Write-Host "signtool.exe present:   $(Test-Path $signtool)"
