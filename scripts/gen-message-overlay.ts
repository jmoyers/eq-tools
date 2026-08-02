// Generate the COMMITTED observed-message-overlay baseline (Task #36).
//
// Replays the FULL real log through the parser + BuffsModule (with the spell DB installed),
// then serializes the mined message overlay to src/main/data/messageOverlay.baseline.json.
// That baseline ships with the app so a FRESH install benefits from everything we already
// learned about the game's cast messages (which are VERIFIED / SHARED / CONTRADICT-WIKI)
// without having to re-mine a 68MB log locally. At runtime the buffs module seeds the miner
// with this baseline, then keeps accreting from the user's own live log on top.
//
// Run: `npm run gen:message-overlay` (uses the real log path below — dev machine only).
// The committed JSON is the deliverable; the log itself is never committed.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { BuffsModule } from '../src/main/modules/buffs'

const LOG =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Primitive_freeport.txt'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'src', 'main', 'data', 'messageOverlay.baseline.json')

const db = loadSpellDb()
installSpellDb(db)
const mod = new BuffsModule(db)
mod.reset()

let seq = 0
const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)
for (const raw of lines) {
  const ev = parseEvent(raw, seq++)
  if (ev) mod.onEvent(ev)
}

const overlay = mod.overlaySnapshot()
// Trim to the USEFUL subset: drop UNKNOWN (single-spell, n<2) noise — it's the bulk and
// adds nothing a fresh install can act on. Keep verified/shared/contradicts-wiki (the
// registry a future agent audits) and cap each message's spell list so the file stays lean.
overlay.messages = overlay.messages
  .filter((m) => m.verdict !== 'unknown')
  .map((m) => ({ ...m, spells: m.spells.slice(0, 12) }))
// updatedAt pinned so re-running on the same log yields a stable diff (only real new
// observations churn, not the timestamp).
overlay.updatedAt = '2026-08-01T00:00:00.000Z'
writeFileSync(OUT, JSON.stringify(overlay, null, 0) + '\n')
console.log(
  `[gen-message-overlay] wrote ${overlay.messages.length} messages ` +
    `(verified=${overlay.stats.verified} shared=${overlay.stats.shared} ` +
    `contradictions=${overlay.stats.contradictions} unknown=${overlay.stats.unknown}) → ${OUT}`
)
