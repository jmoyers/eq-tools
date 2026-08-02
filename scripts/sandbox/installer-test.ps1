# installer-test.ps1 — runs INSIDE Windows Sandbox (invoked by installer-test.wsb's
# LogonCommand). Clean-machine verification of the one-click installer (Task #25):
# silent-install, verify files + shortcut, confirm the app process starts, then
# write PASS/FAIL + details to C:\results\result.txt (mapped back to the host).
#
# The sandbox is a pristine Windows with none of our build tooling — this proves the
# installer stands alone (no Node, no dev instance, no prior install).
#
# FRESH-MACHINE CONFIG NOTE: the sandbox also has NO EverQuest install and NO EQ logs,
# so this doubles as the fresh-machine config check — EQ install-dir discovery finds
# nothing, and the app MUST still launch cleanly (step 5 asserts the process stays
# alive). The user then sets the install folder via the in-app Settings gear
# (SettingsDialog → eqconfig:pick, persisted as electron-store `eqInstallDir`); there
# is no install-time log/config prompt to assert here. See AGENTS.md "EQ install-dir
# discovery + manual override".

$ErrorActionPreference = 'Continue'
$result = 'C:\results\result.txt'
$lines = New-Object System.Collections.Generic.List[string]
function Log($m) { $lines.Add($m); Write-Host $m }
$pass = $true
function Check($name, $ok, $detail = '') {
  if ($ok) { Log "PASS  $name $detail" }
  else { Log "FAIL  $name $detail"; $script:pass = $false }
}

Log "=== eq-tools installer clean-machine test ==="
Log "time: $(Get-Date -Format o)"
Log "host: $env:COMPUTERNAME (sandbox)"

# 1. Find the newest installer in the mapped read-only release folder.
$setup = Get-ChildItem -Path 'C:\release' -Recurse -Filter 'eq-tools-Setup-*.exe' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) {
  Check 'installer-present' $false 'no eq-tools-Setup-*.exe under C:\release'
  Set-Content -Path $result -Value ($lines -join "`r`n")
  exit 1
}
Log "installer: $($setup.FullName)"

# 2. Silent install.
$p = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -PassThru -Wait
Check 'installer-exit-0' ($p.ExitCode -eq 0) "(exit $($p.ExitCode))"
Start-Sleep -Seconds 3

# 3. Verify install path + key files (per-user under %LOCALAPPDATA%\Programs).
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\eq-tools'
$exe = Join-Path $installDir 'EQ Legends Companion.exe'
Check 'install-dir-exists' (Test-Path $installDir) $installDir
Check 'app-exe-exists' (Test-Path $exe)

# 4. Start-menu shortcut.
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\EQ Legends Companion.lnk'
Check 'start-menu-shortcut' (Test-Path $startMenu) $startMenu

# 5. Launch the app and confirm a process starts (GUI shows in the sandbox; here we
#    just confirm the process is alive a few seconds after launch, then close it).
if (Test-Path $exe) {
  $proc = Start-Process -FilePath $exe -PassThru
  Start-Sleep -Seconds 6
  $alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
  Check 'app-process-started' ($null -ne $alive) "(pid $($proc.Id))"
  if ($alive) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}

# 6. Silent uninstall + cleanup check.
$uninstaller = Join-Path $installDir 'Uninstall EQ Legends Companion.exe'
if (Test-Path $uninstaller) {
  $u = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait
  Check 'uninstaller-exit-0' ($u.ExitCode -eq 0) "(exit $($u.ExitCode))"
  Start-Sleep -Seconds 4
  $remaining = @(Get-ChildItem $installDir -Force -ErrorAction SilentlyContinue)
  Check 'uninstall-removed-files' ($remaining.Count -eq 0) "($($remaining.Count) files left)"
}

Log ''
Log ("RESULT: " + ($(if ($pass) { 'PASS' } else { 'FAIL' })))
Set-Content -Path $result -Value ($lines -join "`r`n")
