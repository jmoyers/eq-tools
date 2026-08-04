// gen-telemetry-doc.mts — writes TELEMETRY.md from the schema. `npm run gen:telemetry-doc`.
//
// The doc is a PROMISE to users about what the app is allowed to measure, so it must be
// impossible for it to describe a schema the code does not have. It is therefore generated,
// committed, and pinned: `tests/telemetryDoc.test.mts` re-renders and compares, so a schema
// change that skips this script turns the suite red rather than shipping a doc that lies.
//
// Idempotent by construction (`renderTelemetryDoc` is pure), and it reports whether anything
// actually moved so a no-op run is visible as a no-op.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { docCoversSchema, renderTelemetryDoc } from '../src/shared/telemetryDoc'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const TELEMETRY_DOC_PATH = join(ROOT, 'TELEMETRY.md')

if (!docCoversSchema()) {
  console.error(
    'gen:telemetry-doc: TELEMETRY_DOC_EVENTS does not match TELEMETRY_EVENT_KINDS — every event ' +
      'in the schema needs a doc row (src/shared/telemetryDoc.ts), in the same order.'
  )
  process.exit(1)
}

const next = renderTelemetryDoc()
let before = ''
try {
  before = readFileSync(TELEMETRY_DOC_PATH, 'utf8')
} catch {
  before = ''
}

if (before === next) {
  console.log('gen:telemetry-doc: TELEMETRY.md is already current')
} else {
  writeFileSync(TELEMETRY_DOC_PATH, next, 'utf8')
  console.log(`gen:telemetry-doc: wrote TELEMETRY.md (${String(next.length)} bytes)`)
}
