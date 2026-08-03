// azure-sign.cjs — electron-builder `win.sign` hook: Azure Artifact Signing with
// paths handed over as REAL ARGUMENTS (execFileSync array + pwsh -File parameter),
// so a product name with spaces ("EQ Legends Companion.exe") signs correctly. See
// azure-sign.ps1's header for why the built-in azureSignOptions path cannot do this.
//
// SELF-SKIPPING: without AZURE_SIGNING_ENDPOINT in the environment this is a no-op,
// so local `npm run dist` builds stay unsigned with zero configuration — only CI
// (which injects the AZURE_* secrets) produces signed binaries. The hook is wired
// permanently in electron-builder.yml; the env is the switch.
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

exports.default = async function sign(configuration) {
  if (!process.env.AZURE_SIGNING_ENDPOINT) return
  execFileSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(__dirname, 'azure-sign.ps1'),
      '-Path',
      configuration.path
    ],
    { stdio: 'inherit' }
  )
}
