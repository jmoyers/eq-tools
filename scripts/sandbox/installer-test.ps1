# installer-test.ps1 - runs INSIDE Windows Sandbox (invoked by installer-test.wsb's
# LogonCommand). Clean-machine verification of the one-click installer (Task #25):
# silent-install, verify files + Start-menu shortcut + Add/Remove-Programs registration,
# confirm the app process starts, uninstall, assert full cleanup - then write PASS/FAIL +
# details to C:\results\result.txt (mapped back to the host).
#
# The sandbox is a pristine Windows with none of our build tooling - this proves the
# installer stands alone (no Node, no dev instance, no prior install).
#
# ASCII ONLY. The sandbox runs Windows PowerShell 5.1, which reads a BOM-less .ps1 as
# ANSI; a stray non-ASCII character inside a string is a parse error there and the whole
# harness dies before it can test anything.
#
# FRESH-MACHINE CONFIG NOTE: the sandbox also has NO EverQuest install and NO EQ logs,
# so this doubles as the fresh-machine config check - EQ install-dir discovery finds
# nothing, and the app MUST still launch cleanly (step 5 asserts the process stays
# alive). The user then sets the install folder via the in-app Settings gear
# (SettingsDialog -> eqconfig:pick, persisted as electron-store `eqInstallDir`); there
# is no install-time log/config prompt to assert here. See AGENTS.md "EQ install-dir
# discovery + manual override".
#
# HARNESS RULES (learned the hard way):
#  * result.txt is written from a finally block - a harness that dies silently looks
#    exactly like a hung VM from the host side. Always leave a verdict behind.
#  * The installer glob is the CURRENT product name. A release/ folder holding only a
#    stale-named build FAILS loudly rather than testing nothing.
#  * An NSIS uninstaller launched without `_?=` relaunches itself from %TEMP% and the
#    original process exits IMMEDIATELY, so `Start-Process -Wait` does NOT mean the
#    uninstall finished. Post-uninstall assertions poll instead of sleeping.
#  * This harness only ever uninstalls with `/S`, which must ALWAYS preserve
#    %APPDATA%\everquest-companion (steps 5b/6c). The interactive "Keep your settings and
#    history?" prompt in build/installer.nsh is a MANUAL test - see 6c.

$ErrorActionPreference = 'Continue'
$result = 'C:\results\result.txt'
$lines = New-Object System.Collections.Generic.List[string]
function Log($m) { $lines.Add($m); Write-Host $m }
$pass = $true
function Check($name, $ok, $detail = '') {
  if ($ok) { Log "PASS  $name $detail" }
  else { Log "FAIL  $name $detail"; $script:pass = $false }
}

# Add/Remove Programs lookup. electron-builder names the uninstall key after a UUIDv5 of
# appId (NOT the product name), so we find our entry by DisplayName across every hive
# Settings -> Apps reads.
$arpRoots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
function Get-ArpEntry {
  foreach ($root in $arpRoots) {
    foreach ($key in @(Get-ChildItem $root -ErrorAction SilentlyContinue)) {
      $props = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
      if ($props -and $props.DisplayName -like 'EQ Legends Companion*') {
        Add-Member -InputObject $props -NotePropertyName '_ArpKeyPath' -NotePropertyValue "$root\$($key.PSChildName)" -Force
        return $props
      }
    }
  }
  return $null
}

try {
  Log "=== everquest-companion installer clean-machine test ==="
  Log "time: $(Get-Date -Format o)"
  Log "host: $env:COMPUTERNAME (sandbox)"

  # 1. Find the newest installer in the mapped read-only release folder. The glob is the
  #    CURRENT artifactName; a release/ holding only pre-rename builds must fail loudly.
  $setup = Get-ChildItem -Path 'C:\release' -Recurse -Filter 'everquest-companion-Setup-*.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $setup) {
    $other = @(Get-ChildItem -Path 'C:\release' -Recurse -Filter '*Setup*.exe' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    $why = 'no everquest-companion-Setup-*.exe under C:\release'
    if ($other.Count) { $why += " -- only stale-named build(s) present: $($other -join ', '). Run 'npm run dist' and re-launch the sandbox." }
    else { $why += " -- release/ is empty. Run 'npm run dist' to completion BEFORE launching the sandbox." }
    Check 'installer-present' $false $why
    return
  }
  Check 'installer-present' $true "$($setup.FullName) (built $($setup.LastWriteTime.ToString('o')))"

  # Version comes from the artifact name (everquest-companion-Setup-<version>.exe) so the
  # Add/Remove-Programs assertions below do not need package.json in the sandbox.
  $expectedVersion = ''
  if ($setup.Name -match '^everquest-companion-Setup-(.+)\.exe$') { $expectedVersion = $Matches[1] }
  Log "expected version: $expectedVersion"

  # 2. Silent install.
  $p = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -PassThru -Wait
  Check 'installer-exit-0' ($p.ExitCode -eq 0) "(exit $($p.ExitCode))"
  Start-Sleep -Seconds 3

  # 3. Verify install path + key files (per-user under %LOCALAPPDATA%\Programs). The
  #    install dir derives from package.json `name`, NOT productName.
  $installDir = Join-Path $env:LOCALAPPDATA 'Programs\everquest-companion'
  $exe = Join-Path $installDir 'EQ Legends Companion.exe'
  Check 'install-dir-exists' (Test-Path $installDir) $installDir
  Check 'app-exe-exists' (Test-Path $exe)

  # 4. Start-menu shortcut.
  $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\EQ Legends Companion.lnk'
  Check 'start-menu-shortcut' (Test-Path $startMenu) $startMenu

  # 4b. Add/Remove Programs registration - the ONLY route a normal user has to uninstall
  #     (Settings -> Apps -> Installed apps reads these keys). Files, shortcut and the
  #     on-disk uninstaller can ALL be present while this is missing; that is precisely
  #     the bug this block exists to catch, so each field is named individually.
  $arp = Get-ArpEntry
  if ($null -eq $arp) {
    Check 'arp-entry-exists' $false ("no uninstall key with DisplayName like 'EQ Legends Companion*' under: " + ($arpRoots -join '; ') + " - the app will NOT appear in Settings -> Apps")
  }
  else {
    Check 'arp-entry-exists' $true "($($arp._ArpKeyPath))"
    Check 'arp-DisplayName' ($arp.DisplayName -like 'EQ Legends Companion*') "(DisplayName='$($arp.DisplayName)')"
    Check 'arp-DisplayVersion' ($arp.DisplayVersion -eq $expectedVersion) "(DisplayVersion='$($arp.DisplayVersion)' expected '$expectedVersion')"
    Check 'arp-Publisher' (-not [string]::IsNullOrWhiteSpace($arp.Publisher)) "(Publisher='$($arp.Publisher)')"
    $unStr = [string]$arp.UninstallString
    Check 'arp-UninstallString-points-at-uninstaller' ($unStr -like '*Uninstall EQ Legends Companion.exe*') "(UninstallString='$unStr')"
    $unExe = ''
    if ($unStr -match '^"([^"]+)"') { $unExe = $Matches[1] } else { $unExe = ($unStr -split ' ')[0] }
    Check 'arp-UninstallString-exe-exists' ((-not [string]::IsNullOrWhiteSpace($unExe)) -and (Test-Path $unExe)) "(resolved '$unExe')"
    $loc = [string]$arp.InstallLocation
    Check 'arp-InstallLocation' ($loc.TrimEnd('\') -eq $installDir.TrimEnd('\')) "(InstallLocation='$loc' expected '$installDir')"
  }

  # 5. Launch the app and confirm a process starts (GUI shows in the sandbox; here we
  #    just confirm the process is alive a few seconds after launch, then close it).
  if (Test-Path $exe) {
    $proc = Start-Process -FilePath $exe -PassThru
    Start-Sleep -Seconds 6
    $alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    Check 'app-process-started' ($null -ne $alive) "(pid $($proc.Id))"
    if ($alive) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
  }

  # 5b. Seed the userData dir with a marker so step 6c can prove a SILENT uninstall left
  #     it alone. Launching the app above normally creates it; create it ourselves if not,
  #     so the assertion is deterministic rather than dependent on how far startup got.
  #     (build/installer.nsh's customUnInstall only deletes userData when a HUMAN answers
  #     No to the keep-settings prompt; `/S` must never prompt and never delete. There is
  #     deliberately NO automation of that MessageBox here - see the manual note at 6c.)
  $userData = Join-Path $env:APPDATA 'everquest-companion'
  $marker = Join-Path $userData 'sandbox-uninstall-marker.txt'
  if (-not (Test-Path $userData)) {
    Log "userData dir absent after launch - creating it for the preservation check"
    New-Item -ItemType Directory -Path $userData -Force | Out-Null
  }
  Set-Content -Path $marker -Value 'a silent uninstall must not delete this' -ErrorAction SilentlyContinue
  Check 'userdata-marker-written' (Test-Path $marker) $marker

  # 6. Silent uninstall + cleanup check. NSIS relaunches the uninstaller from %TEMP% and
  #    the process we waited on exits immediately, so poll for real completion (install
  #    dir gone AND the ARP entry - which the uninstaller deletes LAST - gone).
  $uninstaller = Join-Path $installDir 'Uninstall EQ Legends Companion.exe'
  if (Test-Path $uninstaller) {
    $u = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait
    Check 'uninstaller-exit-0' ($u.ExitCode -eq 0) "(exit $($u.ExitCode))"
    $waited = 0
    for ($i = 0; $i -lt 60; $i++) {
      $waited = $i
      $left = @(Get-ChildItem $installDir -Force -ErrorAction SilentlyContinue)
      if ($left.Count -eq 0 -and $null -eq (Get-ArpEntry)) { break }
      Start-Sleep -Seconds 1
    }
    Log "uninstall settled after ~$waited s"
    $remaining = @(Get-ChildItem $installDir -Force -ErrorAction SilentlyContinue)
    Check 'uninstall-removed-files' ($remaining.Count -eq 0) "($($remaining.Count) files left)"
    # 6b. ...and the Add/Remove Programs entry must be gone, or the app haunts Settings.
    $arpAfter = Get-ArpEntry
    if ($null -eq $arpAfter) { Check 'uninstall-removed-arp-entry' $true }
    else { Check 'uninstall-removed-arp-entry' $false "orphaned key left behind: $($arpAfter._ArpKeyPath) (DisplayName='$($arpAfter.DisplayName)')" }

    # 6c. ...but the user's settings/history must SURVIVE a silent uninstall. This is the
    #     contract the keep-settings prompt is built on: `/S` never asks and never
    #     deletes, so scripted uninstalls (and this harness) are non-destructive. Poll
    #     first: the detached uninstaller tail could still be running when we look.
    #     MANUAL TEST, not automated here: run the uninstaller WITHOUT /S (or from
    #     Settings -> Apps) and answer No to "Keep your settings and history?" - the
    #     userData dir must then be gone. Driving that MessageBox from the harness would
    #     mean UI automation inside the VM, which is exactly the flakiness this suite
    #     avoids; the silent half below is the part a script can prove.
    #     The poll above stops at "ARP key gone", but the uninstaller deletes that key
    #     BEFORE customUnInstall runs, so wait for the uninstaller PROCESS to be gone
    #     too: NSIS's relaunched copy runs as Un_<x>.exe out of %TEMP%\~nsu*. (Do NOT
    #     poll for that temp FOLDER instead - it outlives the process and the loop just
    #     burns its whole budget.)
    $unWaited = 0
    for ($i = 0; $i -lt 30; $i++) {
      $unWaited = $i
      if (-not @(Get-Process -Name 'Un_*' -ErrorAction SilentlyContinue).Count) { break }
      Start-Sleep -Seconds 1
    }
    Log "uninstaller process gone after ~$unWaited s"
    Check 'silent-uninstall-preserved-userdata-dir' (Test-Path $userData) $userData
    Check 'silent-uninstall-preserved-userdata-files' (Test-Path $marker) "(marker $marker)"
  }
  else {
    Check 'uninstaller-present' $false "$uninstaller missing - cannot test uninstall"
  }
}
catch {
  Check 'harness-completed' $false "unhandled error: $($_.Exception.Message)"
}
finally {
  Log ''
  if ($pass) { Log 'RESULT: PASS' } else { Log 'RESULT: FAIL' }
  try { Set-Content -Path $result -Value ($lines -join "`r`n") } catch { Write-Host "could not write ${result}: $_" }
  # Teardown is the HOST launcher's job (run-installer-test.ps1 force-kills the client the
  # moment result.txt appears). Shutting the guest down from in here pops a modal
  # "Windows Sandbox is shutting down" notice on the host desktop - don't.
}
