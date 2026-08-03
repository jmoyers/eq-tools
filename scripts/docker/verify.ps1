# verify.ps1 — file-level installer verification, run inside the Server Core
# container (Task #25). No GUI: we silent-install, assert the app exe + uninstaller
# were laid down, silent-uninstall, and assert cleanup. THROWS on any failure so the
# `docker build` RUN step fails loudly (image won't build if the installer is broken).

$ErrorActionPreference = 'Stop'

Write-Host '=== everquest-companion installer file-level verification (Server Core) ==='

$setup = Get-ChildItem -Path 'C:\test\release' -Recurse -Filter 'everquest-companion-Setup-*.exe' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw 'No everquest-companion-Setup-*.exe found under C:\test\release' }
Write-Host "installer: $($setup.FullName)"

# Silent install.
$p = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -PassThru -Wait
if ($p.ExitCode -ne 0) { throw "installer exited $($p.ExitCode)" }
Start-Sleep -Seconds 3

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\everquest-companion'
$exe = Join-Path $installDir 'EQ Legends Companion.exe'
$uninstaller = Join-Path $installDir 'Uninstall EQ Legends Companion.exe'

if (-not (Test-Path $installDir)) { throw "install dir missing: $installDir" }
if (-not (Test-Path $exe)) { throw "app exe missing: $exe" }
if (-not (Test-Path $uninstaller)) { throw "uninstaller missing: $uninstaller" }
Write-Host "PASS  install: exe + uninstaller present under $installDir"

# Add/Remove Programs registration. electron-builder names the uninstall key after a
# UUIDv5 of appId, not the product name, so look our entry up by DisplayName. Without
# this the app is installed but uninstallable from Settings -> Apps.
$arpRoots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
function Get-ArpEntry {
  foreach ($root in $arpRoots) {
    foreach ($key in @(Get-ChildItem $root -ErrorAction SilentlyContinue)) {
      $props = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
      if ($props -and $props.DisplayName -like 'EQ Legends Companion*') { return $props }
    }
  }
  return $null
}
$expectedVersion = ''
if ($setup.Name -match '^everquest-companion-Setup-(.+)\.exe$') { $expectedVersion = $Matches[1] }
$arp = Get-ArpEntry
if (-not $arp) { throw "Add/Remove Programs entry missing: no uninstall key with DisplayName like 'EQ Legends Companion*' under $($arpRoots -join '; ')" }
if ($arp.DisplayVersion -ne $expectedVersion) { throw "ARP DisplayVersion '$($arp.DisplayVersion)' != expected '$expectedVersion'" }
if ([string]::IsNullOrWhiteSpace($arp.Publisher)) { throw 'ARP Publisher is empty' }
if ([string]$arp.UninstallString -notlike '*Uninstall EQ Legends Companion.exe*') { throw "ARP UninstallString does not point at our uninstaller: '$($arp.UninstallString)'" }
if ($arp.InstallLocation -ne $installDir) { throw "ARP InstallLocation '$($arp.InstallLocation)' != expected '$installDir'" }
Write-Host "PASS  add/remove programs: '$($arp.DisplayName)' -> $($arp.UninstallString)"

# Silent uninstall + cleanup.
$u = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait
if ($u.ExitCode -ne 0) { throw "uninstaller exited $($u.ExitCode)" }
Start-Sleep -Seconds 4
$remaining = @(Get-ChildItem $installDir -Force -ErrorAction SilentlyContinue)
if ($remaining.Count -ne 0) { throw "uninstall left $($remaining.Count) files in $installDir" }
$arpAfter = Get-ArpEntry
if ($arpAfter) { throw "uninstall left an orphaned Add/Remove Programs entry: DisplayName='$($arpAfter.DisplayName)' UninstallString='$($arpAfter.UninstallString)'" }
Write-Host 'PASS  uninstall: files removed + add/remove programs entry gone'

Write-Host 'RESULT: PASS'
