# verify.ps1 — file-level installer verification, run inside the Server Core
# container (Task #25). No GUI: we silent-install, assert the app exe + uninstaller
# were laid down, silent-uninstall, and assert cleanup. THROWS on any failure so the
# `docker build` RUN step fails loudly (image won't build if the installer is broken).

$ErrorActionPreference = 'Stop'

Write-Host '=== eq-tools installer file-level verification (Server Core) ==='

$setup = Get-ChildItem -Path 'C:\test\release' -Recurse -Filter 'eq-tools-Setup-*.exe' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw 'No eq-tools-Setup-*.exe found under C:\test\release' }
Write-Host "installer: $($setup.FullName)"

# Silent install.
$p = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -PassThru -Wait
if ($p.ExitCode -ne 0) { throw "installer exited $($p.ExitCode)" }
Start-Sleep -Seconds 3

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\eq-tools'
$exe = Join-Path $installDir 'EQ Legends Companion.exe'
$uninstaller = Join-Path $installDir 'Uninstall EQ Legends Companion.exe'

if (-not (Test-Path $installDir)) { throw "install dir missing: $installDir" }
if (-not (Test-Path $exe)) { throw "app exe missing: $exe" }
if (-not (Test-Path $uninstaller)) { throw "uninstaller missing: $uninstaller" }
Write-Host "PASS  install: exe + uninstaller present under $installDir"

# Silent uninstall + cleanup.
$u = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait
if ($u.ExitCode -ne 0) { throw "uninstaller exited $($u.ExitCode)" }
Start-Sleep -Seconds 4
$remaining = @(Get-ChildItem $installDir -Force -ErrorAction SilentlyContinue)
if ($remaining.Count -ne 0) { throw "uninstall left $($remaining.Count) files in $installDir" }
Write-Host 'PASS  uninstall: files removed'

Write-Host 'RESULT: PASS'
