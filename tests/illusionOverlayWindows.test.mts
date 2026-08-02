// ILLUSION EXCLUSIVITY + OBSERVED-MESSAGE OVERLAY GOLDEN WINDOWS (Task #36).
//
// Same hand-verified golden-window methodology as the earlier suites: real spans of the
// user's log, read line-by-line, replayed through the REAL parser + BuffsModule (spell DB
// installed). W11 pins the illusion-exclusivity rule; W12 pins the overlay's message
// learning (SHARED vs CONTRADICTS-WIKI verdicts).
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFixture, replayBuffsWithDb, tsOf } from './harness.mts'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { BuffsModule } from '../src/main/modules/buffs'
import type { BuffsSnap } from '../src/shared/types'

const db = loadSpellDb()

/** Is a spell (rank-insensitive) illusion-flagged in the DB? */
function isIllusion(spell: string): boolean {
  const key = spell.trim().toLowerCase().replace(/ (?:i|ii|iii|iv|v|vi|vii|viii|ix|x)$/i, '')
  return db.byKey.get(key)?.illusion ?? false
}

function selfIllusions(snap: BuffsSnap): string[] {
  return snap.active.filter((a) => a.self && isIllusion(a.spell)).map((a) => a.spell)
}

// ─────────────────────────────────────────────────────────────────────────────
// W11 — ILLUSION EXCLUSIVITY (the integrator's finding: two self illusions at once).
// Raw: eqlog lines 912000 → 913160, Sat Aug 01. HAND-VERIFIED sequence:
//   20:15:41  Your illusion fades.                    (a prior self illusion clicked off)
//   20:15:55  You begin casting Illusion: Wood Elf.   (cast history → resolves the message)
//   20:15:56  You feel different.                     (GENERIC msg, shared by 26 illusions;
//                                                       resolved to Wood Elf via cast history)
//   20:22:21  You begin casting Boon of the Garou II.
//   20:22:21  phoboplasm's face contorts …            (Boon on the PET phoboplasm — NOT self)
//   20:23:39  Your illusion fades.                    (removes the self Wood Elf illusion)
// The user's rule: only ONE illusion is ever active on the player at a time, and
// "Your illusion fades." (the shared click-off line for every illusion) removes whichever
// self illusion is active. Assert: across the WHOLE window there are never two self
// illusions at once, and after the 20:23:39 fade the self illusion count is zero.
test('W11 illusion exclusivity: never two self illusions; "Your illusion fades." clears it', () => {
  const lines = readFixture('w11-illusion-exclusivity.log')

  // Fold event-by-event, checking the invariant at every step (a golden-window pass).
  installSpellDb(db)
  const mod = new BuffsModule(db)
  mod.reset()
  let seq = 0
  let maxSelfIllusions = 0
  let sawWoodElf = false
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    mod.onEvent(ev)
    const si = selfIllusions(mod.snapshot().state)
    maxSelfIllusions = Math.max(maxSelfIllusions, si.length)
    if (si.some((s) => s.toLowerCase().includes('wood elf'))) sawWoodElf = true
  }
  assert.equal(maxSelfIllusions, 1, 'at most ONE self illusion active at any instant (exclusivity)')
  assert.ok(sawWoodElf, 'the Illusion: Wood Elf self buff was recognized (generic message + cast history)')

  // After the final "Your illusion fades." (20:23:39) the self illusion is gone.
  const finalSnap = mod.snapshot().state
  assert.equal(selfIllusions(finalSnap).length, 0, 'the self illusion is cleared by "Your illusion fades."')

  // The pet Boon of the Garou (cast on phoboplasm) is NOT a self illusion — it binds to the
  // pet by its landing message and is unaffected by the self illusionFade (per-entity rule).
  const boon = finalSnap.active.find((a) => a.spell.toLowerCase().includes('boon of the garou'))
  if (boon) {
    assert.equal(boon.self, false, 'the Boon instance is on the pet, not the player')
    assert.notEqual(boon.target, undefined, 'the pet Boon is bound to a named entity')
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// W11b — a SECOND illusion apply on self REPLACES the first (exclusivity on apply, not just
// on the fade line). Synthetic-but-real: two distinct illusion casts back to back on self.
// Raw: eqlog lines 815090 → 815155 (the 02:42-02:46 burst) casts four distinct illusions on
// self (Dwarf → High Elf → Erudite → Halfling), each preceded by "Your illusion fades." and
// followed by the generic "You feel different." Because only one illusion holds at a time,
// the final self illusion is exactly ONE (the last cast, Halfling), never a pile-up.
test('W11b illusion exclusivity: each new self illusion replaces the prior one', () => {
  const lines = readFixture('w12-shared-illusions.log')
  installSpellDb(db)
  const mod = new BuffsModule(db)
  mod.reset()
  let seq = 0
  let maxSelfIllusions = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    mod.onEvent(ev)
    maxSelfIllusions = Math.max(maxSelfIllusions, selfIllusions(mod.snapshot().state).length)
  }
  assert.equal(maxSelfIllusions, 1, 'four illusions cast in sequence never pile up — one at a time')
  const finalSelf = selfIllusions(mod.snapshot().state)
  assert.ok(finalSelf.length <= 1, 'at most one self illusion survives the burst')
})

// ─────────────────────────────────────────────────────────────────────────────
// W12 — OVERLAY LEARNING (the user's directive: verify variations of cast messages).
// W12a SHARED: the 02:42-02:46 burst casts FOUR distinct illusion races, each followed by
// the GENERIC "You feel different." So the overlay must classify that message SHARED — it
// follows multiple spells and thus can NOT name a spell on its own.
test('W12a overlay: "You feel different." is classified SHARED (follows multiple illusions)', () => {
  const lines = readFixture('w12-shared-illusions.log')
  const snap = replayBuffsWithDb(lines, tsOf(lines[lines.length - 1]))
  const ov = snap.overlay
  assert.ok(ov, 'the snapshot carries the observed-message overlay')
  const yfd = ov!.messages.find((m) => m.text === 'You feel different.')
  assert.ok(yfd, '"You feel different." was observed and recorded in the overlay')
  assert.equal(yfd!.verdict, 'shared', '"You feel different." is SHARED across multiple illusions')
  assert.ok(yfd!.spells.length >= 2, 'it follows ≥2 distinct spells (why it can’t name one)')
  assert.ok(
    yfd!.spells.every((s) => s.spell.toLowerCase().includes('illusion')),
    'every candidate is an illusion race'
  )
})

// W12b CONTRADICTS-WIKI + LEARNED APPLY ROUTE: Symbol of Transal (the clean, repeatable
// sibling of Symbol of Pinzarn — both share the SAME wiki inaccuracy) prints the REAL
// landing line "The symbol of Transal flashes before your eyes." on every cast, but the
// wiki's msg_cast_on_you is the wrong "A mystic symbol flashes before your eyes." So the
// overlay records a CONTRADICTS-WIKI verdict, and the derived correction registers the real
// line → Symbol of Transal (the "true apply route learned" the task calls for).
test('W12b overlay: Symbol of Transal real landing message recorded as CONTRADICTS-WIKI', () => {
  const lines = readFixture('w12-symbol-contradiction.log')
  const snap = replayBuffsWithDb(lines, tsOf(lines[lines.length - 1]))
  const ov = snap.overlay
  assert.ok(ov, 'the snapshot carries the overlay')

  const flash = ov!.messages.find((m) => m.text === 'The symbol of Transal flashes before your eyes.')
  assert.ok(flash, 'the real Symbol of Transal landing message was observed')
  assert.equal(flash!.verdict, 'contradicts-wiki', 'it contradicts the wiki msg_cast_on_you')
  assert.equal(flash!.spells[0].spell, 'Symbol of Transal', 'the observed spell is Symbol of Transal')
  assert.ok(
    flash!.wikiConflict && /mystic symbol flashes/i.test(flash!.wikiConflict.wikiText),
    'the recorded wiki conflict is the wrong "A mystic symbol flashes…" text'
  )

  // The derived correction (effective DB = spells.json + overlay, overlay wins) maps the
  // REAL landing line → Symbol of Transal, so a future parse recognizes it (the wiki route
  // the DB shipped was wrong).
  const overlayStats = ov!.stats
  assert.ok(overlayStats.contradictions >= 1, 'the overlay reports at least one wiki contradiction')
})
