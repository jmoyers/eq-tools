# build/installer.nsh - auto-included by electron-builder (buildResources/installer.nsh
# is the default for `nsis.include`; no electron-builder.yml wiring needed).
#
# Why this exists: app-builder-lib's registryAddInstallInfo (templates/nsis/include/
# installer.nsh) writes InstallLocation only to INSTALL_REGISTRY_KEY
# (HKCU\Software\<appId-uuid>). The Add/Remove Programs key
# (HKCU\...\CurrentVersion\Uninstall\<appId-uuid>) gets DisplayName, DisplayVersion,
# Publisher, UninstallString, QuietUninstallString, DisplayIcon, EstimatedSize - but NOT
# InstallLocation, so Windows Settings -> Apps shows a blank install location. Mirror it.
#
# customInstall is inserted at the END of installSection.nsh, after registryAddInstallInfo
# and the shortcuts, so $INSTDIR and SHELL_CONTEXT are already correct (SHELL_CONTEXT is
# `current` for our per-user oneClick/perMachine:false install). The uninstaller's
# DeleteRegKey removes the whole key, so this adds nothing to clean up.
#
# NOTE: this file is included at the TOP of the generated .nsi, BEFORE multiUser.nsh
# defines UNINSTALL_REGISTRY_KEY. Spell the path out from UNINSTALL_APP_KEY (passed on
# the compiler command line by NsisTarget, so it exists from line 1) rather than relying
# on a define that does not exist yet at this point in the script.
!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "InstallLocation" "$INSTDIR"
!macroend

# ---------------------------------------------------------------------------------------
# customUnInstall - "keep your settings?" prompt on INTERACTIVE uninstall only.
#
# electron-builder.yml keeps `deleteAppDataOnUninstall: false`, so the stock template
# never touches %APPDATA%. This macro is the ONLY code path that can delete user data,
# and it only runs when a human answered No to the question below.
#
# WHAT WAS VERIFIED about the uninstaller's macro context (app-builder-lib 25.x,
# templates/nsis/*), because almost none of it is what you would guess:
#
#  * `${Silent}` IS USELESS HERE. For a oneClick build, uninstaller.nsh's `un.onInit`
#    shows the stock "are you sure you want to uninstall" MB_OKCANCEL and then calls
#    `SetSilent silent` ("one-click installer executes uninstall section in the silent
#    mode"). By the time the `un.install` section - and therefore this macro - runs,
#    ${Silent} is TRUE for BOTH an interactive uninstall and a `/S` one. A
#    `${IfNot} ${Silent}` guard would compile fine and simply never fire, i.e. the
#    prompt would never appear. Detect the REAL request instead, from the command line:
#    `/S` present => scripted/silent => never prompt, always preserve.
#    (`${GetParameters}`/`${GetOptions}` come from FileFunc.nsh, which multiUser.nsh
#    includes near the top of the .nsi - long before this macro is inserted. The stock
#    section uses the same pair three lines above the insertion point to parse
#    `--delete-app-data`.) The relaunched-from-%TEMP% copy of the uninstaller keeps the
#    original command line - that is why `Uninstall*.exe /S` is silent end-to-end today,
#    and it is what the tier-2 sandbox harness relies on.
#  * `${isUpdated}` (StdUtils.TestParameter "--updated") IS available - the generated
#    header defines it above this file's include. electron-updater never uninstalls, but
#    an update-driven uninstall would also pass `/S`; both are checked, belt and braces.
#  * `$installMode` is multiUser.nsh's Var, set by `initMultiUser` in un.onInit. For our
#    per-user install it is "CurrentUser", so SHELL_CONTEXT is `current` and $APPDATA is
#    the real per-user roaming dir. The all-users guard mirrors the stock
#    DELETE_APP_DATA_ON_UNINSTALL block verbatim ("electron always uses per user app
#    data") so this stays correct if perMachine is ever flipped.
#  * customUnInstall is inserted at the END of the `un.install` section, AFTER
#    `RMDir /r $INSTDIR`, the shortcut removal and the DeleteRegKey calls, and just
#    before ONE_CLICK's quitSuccess. Files are already gone when the prompt appears;
#    that is fine (nothing here depends on $INSTDIR) and it is the only hook available.
#  * The dir name is spelled out, NOT taken from ${APP_PACKAGE_NAME}. `RMDir /r` on an
#    accidentally-empty define would be `RMDir /r "$APPDATA\"` - the entire roaming
#    profile. It must stay in sync with package.json `name` (= Electron's
#    app.getName(), there being no productName in package.json) and with the prod row of
#    src/main/channel.ts. NEVER widen this: `%APPDATA%\eq-tools` is the pre-rename
#    BACKUP that the one-time seed reads from, and `%APPDATA%\everquest-companion-dev`
#    is the running dev app's data. Neither is ours to delete.
!macro customUnInstall
  # Build-time proof that the hook actually fires. `!ifmacrodef customUnInstall` lives in
  # uninstaller.nsh, which is only !included in the -DBUILD_UNINSTALLER pass, so this line
  # prints exactly once per `npm run dist` (visible with DEBUG=electron-builder). If it
  # ever stops printing, electron-builder stopped inserting this macro and the prompt is
  # silently gone. !verbose 4 is needed for !echo to print at all; it is NOT a warning, so
  # makensis's -WX stays happy.
  !verbose push
  !verbose 4
  !echo "everquest-companion: customUnInstall inserted (keep-settings prompt is live)"
  !verbose pop

  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "/S" $R1
  ${IfNot} ${Errors}
    # /S on the command line: scripted or updater-driven. Preserve silently.
    Goto eqKeepUserData
  ${EndIf}
  ${If} ${isUpdated}
    Goto eqKeepUserData
  ${EndIf}

  # Interactive uninstall. Yes (default button, and the /SD fallback) keeps everything.
  # Deliberately ONE line: this file has a history of "compiles clean, installer dies",
  # and a line continuation inside a macro body is not worth re-litigating.
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1|MB_TOPMOST|MB_SETFOREGROUND "Keep your settings and history?$\r$\n$\r$\nThey'll be restored if you reinstall EQ Legends Companion.$\r$\n(Choosing No deletes them permanently.)" /SD IDYES IDYES eqKeepUserData

  ${If} $installMode == "all"
    SetShellVarContext current
  ${EndIf}
  RMDir /r "$APPDATA\everquest-companion"
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}

  eqKeepUserData:
  # GetOptions leaves the error flag set when the switch is absent; don't hand that on.
  ClearErrors
!macroend
