// FULL-LOG REPLAY SMOKE TEST (Task #33).
//
// Replays the ENTIRE real log through the parser + BuffsModule and asserts the final
// world model is plausible — the invariants the user's complaint was about, checked
// programmatically over 900k+ lines rather than a hand-picked window:
//   - NO active older than the hygiene cap (no "287h" rows, ever).
//   - NO active bound to a retired entity (every active target is the CURRENT pet or self).
//   - the mined duration stats table is sane (rank-merged: no bare-Roman spell keys).
//
// This test is SKIPPED automatically if the real log isn't present (CI without the log).
// Locally it runs against the live log path.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { parseEvent } from '../src/main/log/parser'
import { BuffsModule } from '../src/main/modules/buffs'

const LOG =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Primitive_freeport.txt'

const HYGIENE_ABSOLUTE_MS = 90 * 60_000

test('full-log replay: final active list has no stale or retired-entity bindings', { skip: !existsSync(LOG) }, () => {
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)
  const mod = new BuffsModule()
  mod.reset()
  let seq = 0
  let lastTs = 0
  // Track the CURRENT live pet key(s) as the parser sees them, to prove no active binds a
  // retired entity. A pet is live between its charm/claim and the next uncharm/zone/
  // succession/death (mirrors the module's own entity rules, independently derived here).
  let charmedKey: string | undefined
  // A charm that BROKE but whose entity is not yet retired (Task #37): the mob keeps its
  // identity + buffs through the break (disposition, not identity), so a buff still bound to it
  // is NOT a retired-entity leak. It's cleared by a death of that name, a zone, or succession.
  let brokenCharmKey: string | undefined
  let summonedKey: string | undefined
  const idKey = (s: string) => s.trim().toLowerCase()
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    mod.onEvent(ev)
    if (ev.ts > lastTs) lastTs = ev.ts
    switch (ev.kind) {
      case 'charm': {
        const k = idKey(ev.mob)
        // Re-charming the same (possibly broken) name is the SAME entity — not succession.
        if (k !== charmedKey && k !== brokenCharmKey) summonedKey = undefined
        charmedKey = k
        brokenCharmKey = undefined
        break
      }
      case 'petClaim': {
        const k = idKey(ev.name)
        if (k !== charmedKey && k !== brokenCharmKey) {
          summonedKey = k
          charmedKey = undefined
          brokenCharmKey = undefined
        }
        break
      }
      case 'uncharm':
        // Charm break moves the entity to the broken-charm slot (still valid, buffs intact).
        if (charmedKey === idKey(ev.mob)) {
          brokenCharmKey = charmedKey
          charmedKey = undefined
        }
        break
      case 'death':
        // A death of the broken-charm name retires it (rule #3): buffs on it are then leaks.
        if (idKey(ev.name) === brokenCharmKey) brokenCharmKey = undefined
        break
      case 'zone':
        charmedKey = undefined // charmed pet left behind (summoned follows)
        brokenCharmKey = undefined // a broken-charm entity is left behind too
        break
    }
  }
  mod.onTick(lastTs)
  const snap = mod.snapshot().state

  // (1) No active older than its hygiene cap.
  for (const a of snap.active) {
    if (a.provisional) continue
    const cap = Math.max(a.p75 != null && a.n >= 2 ? 2 * a.p75 : 0, HYGIENE_ABSOLUTE_MS)
    const elapsed = lastTs - a.startedTs
    assert.ok(elapsed <= cap, `active "${a.spell}" is ${Math.round(elapsed / 60_000)}m old (> cap ${Math.round(cap / 60_000)}m)`)
  }

  // (2) No active bound to a retired entity (Task #35): a pet-disposition instance targets
  // the CURRENT pet. Instances are keyed by (spell, entity); a buff on the pet carries the
  // pet's disposition ('charmed'/'summoned') and its name in `target`.
  for (const a of snap.active) {
    if (a.self) continue
    if (a.disposition !== 'charmed' && a.disposition !== 'summoned') continue
    if (!a.target || a.target === 'pet') continue
    const t = idKey(a.target)
    assert.ok(
      t === charmedKey || t === summonedKey || t === brokenCharmKey,
      `pet buff "${a.spell}" bound to "${a.target}" which is not the current or broken-charm pet (charmed=${charmedKey} broken=${brokenCharmKey} summoned=${summonedKey})`
    )
  }

  // (3) Mined stats are rank-merged: no key ends in a bare Roman numeral.
  for (const key of Object.keys(snap.stats)) {
    assert.ok(!/ (?:i|ii|iii|iv|v|vi|vii|viii|ix|x)$/.test(key), `stat key "${key}" still carries a Roman rank tail`)
  }
})
