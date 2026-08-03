# azure-sign.ps1 — sign ONE file with Azure Artifact Signing (Trusted Signing).
#
# Called per-file by scripts/azure-sign.cjs (electron-builder's win.sign hook). The
# path arrives as a real PowerShell PARAMETER, never as text spliced into a command
# string — which is the entire reason this script exists: electron-builder 25's
# built-in azureSignOptions path builds `pwsh -Command "... -Files <path>"` UNQUOTED,
# so `EQ Legends Companion.exe` splits at the first space and signing dies with
# "File not found: ...\EQ" (documented upstream: electron-builder code-signing-win
# docs + @electron/windows-sign#45 — paths with spaces are unsupported there).
#
# Auth: Invoke-TrustedSigning resolves credentials via DefaultAzureCredential, which
# reads AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET from the environment
# (the CI job env). The RFC3161 timestamp is NOT optional: without it every signature
# dies with the certificate's short-lived validity (Trusted Signing certs rotate
# quickly by design); with it, signatures stay valid past rotation.
param(
  [Parameter(Mandatory = $true)][string]$Path
)
$ErrorActionPreference = 'Stop'
Invoke-TrustedSigning `
  -Endpoint $env:AZURE_SIGNING_ENDPOINT `
  -CodeSigningAccountName $env:AZURE_SIGNING_ACCOUNT `
  -CertificateProfileName $env:AZURE_SIGNING_PROFILE `
  -Files $Path `
  -FileDigest SHA256 `
  -TimestampRfc3161 'http://timestamp.acs.microsoft.com' `
  -TimestampDigest SHA256
