// CHARM BREAK / RE-CHARM GOLDEN WINDOWS (Task #37).
//
// PRINCIPLE (the user's directive): charm/uncharm changes an entity's DISPOSITION, never its
// IDENTITY. When a charmed pet's charm breaks and you re-charm the SAME mob, it is the SAME
// entity — the mob keeps all its buffs through the break. The DEFECT this pins: the old
// `uncharm` handler called `retireEntity(charmedKey)`, which CENSORED every buff instance
// bound to the pet — so a break→re-charm cycle RESET the pet's buffs (the user's report).
//
// Same hand-verified golden-window methodology as W1–W12: real spans of the user's log
// (eqlog_Primitive_freeport.txt), read line-by-line, replayed through the REAL parser +
// BuffsModule with the scraped spell DB installed (replayBuffsWithDb).
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFixture, tsOf } from './harness.mts'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { BuffsModule } from '../src/main/modules/buffs'
import type { BuffsSnap } from '../src/shared/types'

const db = loadSpellDb()

/** The pet-bound (non-self) instance of a spell, if active. */
function petBuff(snap: BuffsSnap, spellContains: string) {
  const needle = spellContains.toLowerCase()
  return snap.active.find((a) => !a.self && a.spell.toLowerCase().includes(needle))
}

// ─────────────────────────────────────────────────────────────────────────────
// W13 — CHARM BREAK PRESERVES THE ENTITY + ITS BUFFS.
// Raw: eqlog lines 903820 → 905600 (Sat Aug 01, The Permafrost Caverns). HAND-VERIFIED:
//   19:54:49  You begin casting Tashani → "an ice giant glances nervously about."
//                                          (Tashani, an INT/resist DEBUFF, bound to the mob)
//   19:54:56  an ice giant has been charmed.        (the mob becomes your pet)
//   19:55:45  You begin casting Tashani → "an ice giant glances nervously about."
//                                          (re-applied on the SAME entity while charmed)
//   19:55:52  Your Allure spell has worn off of an ice giant.  (charm BREAK — hostile window)
//   19:55:59  an ice giant has been charmed.        (RE-CHARM the SAME name, 7s later)
// Tashani binds to the entity 'an ice giant' by its cast-on-other message. Because the mob
// keeps its identity through the break, the Tashani instance is active BEFORE the break, STILL
// active during the 7s hostile window, and STILL active after the re-charm — never censored.
test('W13 charm break → re-charm (same name, no death/zone): the pet keeps its buffs', () => {
  const lines = readFixture('w13-charm-break-recharm.log')

  installSpellDb(db)
  const mod = new BuffsModule(db)
  mod.reset()
  let seq = 0

  let sawCharm = false
  let brokeCharm = false
  let recharmed = false
  let tashaniAtBreak = false
  let tashaniDuringWindow = true
  let tashaniAfterRecharm = false

  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    mod.onEvent(ev)
    const t = petBuff(mod.snapshot().state, 'tashan')

    if (raw.includes('an ice giant has been charmed.')) {
      if (!sawCharm) sawCharm = true
      else if (brokeCharm) {
        recharmed = true
        // The re-charm reconnects the SAME entity — Tashani is still on it.
        tashaniAfterRecharm = !!t
      }
    }
    if (raw.includes('Your Allure spell has worn off of an ice giant.')) {
      brokeCharm = true
      // At the instant the charm breaks, the pet's Tashani must still be active.
      tashaniAtBreak = !!t
    }
    // Across the whole 7s hostile window (after the break, before the re-charm) Tashani stays.
    if (brokeCharm && !recharmed) tashaniDuringWindow = tashaniDuringWindow && !!t
  }

  assert.ok(sawCharm, 'the ice giant was charmed')
  assert.ok(brokeCharm, 'the charm broke (Allure worn off)')
  assert.ok(recharmed, 'the same-named ice giant was re-charmed')
  assert.ok(tashaniAtBreak, 'Tashani is STILL on the pet at the moment the charm breaks (not reset)')
  assert.ok(tashaniDuringWindow, 'Tashani stays on the entity through the whole hostile window')
  assert.ok(tashaniAfterRecharm, 'Tashani is STILL on the pet after the re-charm — same entity')

  // Final: the debuff instance is bound to 'an ice giant' (the pet), never dropped.
  const final = mod.snapshot().state
  const tash = petBuff(final, 'tashan')
  assert.ok(tash, 'Tashani survives the whole break→re-charm cycle as a pet-bound instance')
  assert.equal(tash!.self, false, 'Tashani is bound to the ice giant, not the player')
  assert.equal((tash!.target ?? '').toLowerCase(), 'an ice giant', 'bound to the ice giant entity')
})

// ─────────────────────────────────────────────────────────────────────────────
// W13b — CONTRAST: a DEATH between the break and the re-charm ⇒ buffs do NOT carry (rule #3).
// SYNTHESIZED FROM THE REAL W13 SPAN (task-permitted): the same window with ONE real-format
// death line spliced between the uncharm (19:55:52) and the re-charm (19:55:59):
//   19:55:54  an ice giant has been slain by a frost giant!
// The ex-pet is a hostile mob now; a death naming it RETIRES the broken-charm entity and
// CENSORS its Tashani. So when the same name is re-charmed at 19:55:59 it is a genuinely NEW
// entity with no buffs. This proves disposition-vs-identity cuts both ways.
test('W13b charm break → DEATH of that name → re-charm: buffs do NOT carry (new entity)', () => {
  const lines = readFixture('w13b-charm-break-death-recharm.log')

  installSpellDb(db)
  const mod = new BuffsModule(db)
  mod.reset()
  let seq = 0

  let deathSeen = false
  let recharmed = false
  let tashaniAtBreak = false
  let tashaniAfterDeath = true
  let tashaniAfterRecharm = false
  let sawCharm = false
  let brokeCharm = false

  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    mod.onEvent(ev)
    const t = petBuff(mod.snapshot().state, 'tashan')

    if (raw.includes('an ice giant has been charmed.')) {
      if (!sawCharm) sawCharm = true
      else if (brokeCharm) {
        recharmed = true
        tashaniAfterRecharm = !!t
      }
    }
    if (raw.includes('Your Allure spell has worn off of an ice giant.')) {
      brokeCharm = true
      tashaniAtBreak = !!t
    }
    if (raw.includes('an ice giant has been slain by a frost giant!')) {
      deathSeen = true
      // The death censors the ex-pet's Tashani immediately.
      tashaniAfterDeath = !!t
    }
  }

  assert.ok(brokeCharm && deathSeen && recharmed, 'break → death → re-charm sequence replayed')
  assert.ok(tashaniAtBreak, 'Tashani was on the pet at the break (same start state as W13)')
  assert.equal(tashaniAfterDeath, false, 'the death censors the ex-pet Tashani (retired entity)')
  assert.equal(tashaniAfterRecharm, false, 'the re-charm binds a NEW entity — no carried buffs')

  const final = mod.snapshot().state
  assert.equal(petBuff(final, 'tashan'), undefined, 'no Tashani on the freshly re-charmed entity')
})

// ─────────────────────────────────────────────────────────────────────────────
// W13c — SUCCESSION UNCHANGED: charming a DIFFERENT mob after a break retires the ex-pet.
// A break of 'an ice giant' followed by a charm of a DIFFERENT name is single-pet succession
// (Task #33) — the ex-pet is left behind and its Tashani censored. This guards that the #37
// fix (re-charm of the SAME name must NOT self-retire) did not weaken succession for a real
// pet swap. Built inline from the W13 fixture head (charm + Tashani + break) with a different
// mob charmed instead of the same one.
test('W13c break → charm a DIFFERENT mob: succession still retires the ex-pet buffs', () => {
  const head = readFixture('w13-charm-break-recharm.log').filter(
    (l) => tsOf(l) <= tsOf('[Sat Aug 01 19:55:52 2026] x')
  )
  const lines = [
    ...head,
    '[Sat Aug 01 19:56:05 2026] a frost giant has been charmed.'
  ]

  installSpellDb(db)
  const mod = new BuffsModule(db)
  mod.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  const final = mod.snapshot().state
  // The old ice-giant Tashani is gone (ex-pet retired by succession to the frost giant).
  assert.equal(
    petBuff(final, 'tashan'),
    undefined,
    'charming a DIFFERENT mob retires the broken-charm ex-pet and censors its buffs'
  )
})
