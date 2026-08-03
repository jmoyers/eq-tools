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
