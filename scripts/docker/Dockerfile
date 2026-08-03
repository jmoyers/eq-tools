# Clean-machine, FILE-LEVEL installer verification on Windows Server Core (Task #25).
#
# Server Core has no interactive desktop, so this proves the installer EXTRACTS and
# lays down its files/uninstaller correctly on a pristine Windows — it does NOT test
# the GUI launch (use the Windows Sandbox harness, scripts/sandbox, for that).
#
# The NSIS one-click installer is per-user under %LOCALAPPDATA%\Programs; in a
# container the ContainerAdministrator profile provides that path. We run the setup
# silently (/S), then assert the app exe + uninstaller exist, then silent-uninstall
# and assert cleanup.
#
# Requires Windows containers (Docker Desktop → "Switch to Windows containers", or a
# Windows CI runner). Not runnable from a Linux daemon. Neither is enabled on this
# dev machine — this harness is ready-to-run once Windows containers are available.
#
# Build context = repo root, so release/ is available. Build + run:
#   docker build -f scripts/docker/Dockerfile -t everquest-companion-installer-test .
#   docker run --rm everquest-companion-installer-test
# A non-zero exit = verification failed (the RUN step throws).

# Pin a Server Core tag matching your host build (ltsc2022 for Win11/Server 2022).
FROM mcr.microsoft.com/windows/servercore:ltsc2022

SHELL ["powershell", "-Command", "$ErrorActionPreference='Stop';"]

# Copy the built installers into the image. (release/ is produced by `npm run dist`.)
WORKDIR C:/test
COPY release/ C:/test/release/

# Copy the verification script and run it as the image's smoke test.
COPY scripts/docker/verify.ps1 C:/test/verify.ps1
RUN powershell -ExecutionPolicy Bypass -NoProfile -File C:/test/verify.ps1

# If the RUN above succeeded, the image built = the installer passed file-level
# verification. `docker run` just re-echoes the result for a live run.
CMD ["powershell", "-NoProfile", "-Command", "Write-Host 'everquest-companion installer file-level verification: image built OK (see build log for PASS lines).'"]
