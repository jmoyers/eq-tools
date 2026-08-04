// Runs every e2e spec SEQUENTIALLY and fails if ANY failed — unlike `a && b`,
// one spec's red exit cannot silently skip the specs after it (which is exactly
// what happened while the known combat-header failure kept spec 1 at exit 1:
// `npm run test:e2e` never reached the overview spec at all).
//
// Specs share the singleton e2e build + userData conventions, so they must not
// run concurrently — sequential is a constraint here, not a simplification.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SPECS = [
  'combat-dashboard.e2e.mts',
  'overview.e2e.mts',
  'maps.e2e.mts',
  'copy.e2e.mts',
  'feedback.e2e.mts',
  'voice-alerts.e2e.mts'
]

let failed = 0
for (const spec of SPECS) {
  const res = spawnSync(process.execPath, ['--import', 'tsx', join(here, spec)], {
    stdio: 'inherit'
  })
  if (res.status !== 0) {
    failed += 1
    console.error(`\n[e2e] ${spec} exited ${String(res.status ?? 'signal')}`)
  }
}
console.log(`\n[e2e] ${String(SPECS.length - failed)}/${String(SPECS.length)} specs green`)
process.exit(failed === 0 ? 0 : 1)
