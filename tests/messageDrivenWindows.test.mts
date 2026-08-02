// MESSAGE-DRIVEN GOLDEN-WINDOW TESTS (Task #34).
//
// Same hand-verified golden-window methodology as goldenWindows.test.mts (W1–W6), but for
// the message-driven buff model: the scraped spell DB (src/main/data/spells.json) is
// installed on the parser so it emits PRECISE buffApply / buffWearOff events from the exact
// chat messages the game prints, and the BuffsModule tracks the player's real self bar from
// them (plus self-heal-by-buff applies and Permanent Illusion).
//
// These use `replayBuffsWithDb` (DB installed) — separate from W1–W6's DB-free replay.
// node:test runs files sequentially and replayBuffs() clears the shared parser DB before
// each DB-free window, so the two suites never interfere.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFixture, replayBuffsWithDb, findActive, tsOf } from './harness.mts'

const MIN = 60_000

// ─────────────────────────────────────────────────────────────────────────────
// W7 — QUICK BUFF BURST (the user's invisible self buffs, finally visible).
// Raw: eqlog lines 912560 (Swift cast 20:22:13) → 915490 (20:29:52), Sat Aug 01. Primed
// (w7-priming.log) with a real Clarity III cast (18:46:49) so the ambiguous burst message
// "A cool breeze slips through your mind." (shared by Clarity + others) resolves to Clarity.
// HAND-VERIFIED sequence (the 20:29:44 burst):
//   20:29:44  You activate Quick Buff.        (aaActivate — burst context)
//   20:29:46  You feel valorous.              → Valor  (UNIQUE msg_cast_on_you)
//   20:29:46  You healed Primitive … by Valor.        (self-heal-by-buff reinforces Valor)
//   20:29:46  The symbol of Pinzarn flashes … (wiki msg is wrong, but the next line names it)
//   20:29:46  You healed Primitive … by Symbol of Pinzarn.  → Symbol of Pinzarn (heal apply)
//   20:29:46  You feel much faster.           → Swift Like the Wind (resolved via cast hist)
//   20:29:46  A cool breeze slips through …   → Clarity (resolved via primed cast history)
// CRITICALLY: the burst prints NO "You begin casting" lines — the OLD cast-timing miner saw
// nothing, which is exactly why the user's self buffs were invisible. The message model sees
// them. Expect Clarity/Valor/Symbol of Pinzarn/Swift active as SELF buffs with DB durations.
test('W7 Quick Buff burst: self Clarity/Valor/Symbol/Swift visible with no cast lines', () => {
  const prime = readFixture('w7-priming.log')
  const lines = readFixture('w7-quick-buff.log')
  const observe = tsOf('[Sat Aug 01 20:29:52 2026] x')
  const snap = replayBuffsWithDb(lines, observe, { prime })

  for (const [needle, dbMin] of [
    ['clarity', 27],
    ['valor', 54],
    ['symbol of pinzarn', 45],
    ['swift like the wind', 16]
  ] as const) {
    const a = findActive(snap, needle)
    assert.ok(a, `${needle} should be an active SELF buff from the Quick Buff burst`)
    assert.equal(a!.cls, 'buff', `${needle} is a beneficial buff (spell property, Task #35)`)
    assert.equal(a!.self, true, `${needle} instance is on the player`)
    assert.equal(a!.durationSource, 'db', `${needle} uses the authoritative DB duration`)
    assert.equal(a!.messageDriven, true, `${needle} was applied by an exact chat message`)
    assert.equal(a!.provisional, undefined, `${needle} is confident (not provisional)`)
    // DB duration matches the wiki value.
    assert.equal(Math.round((a!.estimatedMs ?? 0) / MIN), dbMin, `${needle} DB duration ~${dbMin}m`)
  }

  // The burst landed at 20:29:46; elapsed is a few seconds at 20:29:52.
  const clarity = findActive(snap, 'clarity')!
  assert.ok(observe - clarity.startedTs < 30_000, 'burst applies just landed (seconds ago)')
})

// ─────────────────────────────────────────────────────────────────────────────
// W8 — WEARS-OFF REMOVES AN ACTIVE (message-driven expiry, favored over estimate).
// Raw: eqlog lines 915470 → 923352, Sat Aug 01. Valor applies via the UNIQUE "You feel
// valorous." in the 20:29:46 Quick Buff burst and is removed by the UNIQUE "Your valor
// fades." at 20:55:15 — 25.5 min later, well under Valor's 54-min DB duration, so the
// removal is the MESSAGE, not a hygiene sweep. (These are the msg_cast_on_you / msg_wears_off
// wiki fields for Valor; both are unique so no cast-history priming is needed.)
test('W8 wears-off: "Your valor fades." authoritatively removes the active Valor', () => {
  const lines = readFixture('w8-wears-off.log')
  const wearTs = tsOf('[Sat Aug 01 20:55:15 2026] x')

  // BEFORE the wear-off line, Valor is active (a real self buff, DB duration).
  const before = lines.filter((l) => tsOf(l) > 0 && tsOf(l) < wearTs)
  const snapBefore = replayBuffsWithDb(before, wearTs - 1000)
  const valorBefore = findActive(snapBefore, 'valor')
  assert.ok(valorBefore, 'Valor should be active before "Your valor fades."')
  assert.equal(valorBefore!.cls, 'buff', 'Valor is a beneficial buff (spell property)')
  assert.equal(valorBefore!.self, true, 'this Valor instance is on the player')
  assert.equal(valorBefore!.durationSource, 'db', 'Valor duration is authoritative (DB)')
  // It has NOT yet exceeded its DB duration (removal is the message, not a timeout).
  assert.ok(wearTs - valorBefore!.startedTs < 54 * MIN, 'Valor removed before its 54-min DB window elapses')

  // AFTER the wear-off line, Valor is gone.
  const snapAfter = replayBuffsWithDb(lines, tsOf(lines[lines.length - 1]))
  assert.ok(!findActive(snapAfter, 'valor'), 'Valor cleared by its "Your valor fades." message')
})

// ─────────────────────────────────────────────────────────────────────────────
// W9 — PERMANENT ILLUSION + COEXISTING INSTANCES (Task #35 upgrade).
// Raw: eqlog lines 635150 → 639850, Fri Jul 31. The Permanent Illusion AA is purchased at
// 00:40:53 (line 635160). Boon of the Garou is an ILLUSION-flagged spell (DB illusion:true).
// HAND-VERIFIED sequence (all AFTER the purchase):
//   00:44:37  You begin casting Boon of the Garou II.
//   00:44:38  You feel... strange.            → SELF-cast Boon → PERMANENT (illusion AA owned)
//   00:48:10  You begin casting Boon of the Garou II.
//   00:48:10  an abhorrent's face contorts …  → PET-cast Boon on the charmed abhorrent → NORMAL
//   00:54:07  Your Boon of the Garou spell has worn off of an abhorrent.  (the pet Boon fades)
//
// TASK #35: a buff INSTANCE is (spell, entity), so the SAME spell coexists on self AND on
// the pet as TWO independent instances — the old "one active per spell" limitation is gone.
// At 00:48:10 we assert BOTH SIMULTANEOUSLY: the permanent self Boon (∞) and the normal pet
// Boon (6-min DB estimate) are BOTH active at once.
test('W9 Permanent Illusion: self permanent Boon + pet normal Boon coexist as two instances', () => {
  const lines = readFixture('w9-permanent-illusion.log')
  const selfTs = tsOf('[Fri Jul 31 00:44:38 2026] x')
  const petTs = tsOf('[Fri Jul 31 00:48:10 2026] x')

  // After the SELF-cast (00:44:38, post-purchase): Boon is a PERMANENT self buff.
  const throughSelf = lines.filter((l) => tsOf(l) > 0 && tsOf(l) <= selfTs)
  const snapSelf = replayBuffsWithDb(throughSelf, selfTs)
  const boonSelf = findActive(snapSelf, 'boon of the garou')
  assert.ok(boonSelf, 'self-cast Boon of the Garou should be active')
  assert.equal(boonSelf!.cls, 'buff', 'Boon is a beneficial buff (spell property)')
  assert.equal(boonSelf!.self, true, 'this instance is on the player')
  assert.equal(boonSelf!.permanent, true, 'self-cast illusion is PERMANENT (Permanent Illusion AA)')
  assert.equal(boonSelf!.estimatedMs, null, 'a permanent buff has no finite estimate/countdown')

  // After the PET-cast (00:48:10): BOTH the self permanent Boon AND a NEW pet Boon are active
  // AT THE SAME TIME — two instances of one spell, keyed by (spell, entity) (Task #35).
  const throughPet = lines.filter((l) => tsOf(l) > 0 && tsOf(l) <= petTs)
  const snapPet = replayBuffsWithDb(throughPet, petTs)
  const boons = snapPet.active.filter((a) => a.spell.toLowerCase().includes('boon of the garou'))
  assert.equal(boons.length, 2, 'self AND pet Boon coexist as two simultaneous instances')

  const selfBoon = boons.find((b) => b.self)
  const petBoon = boons.find((b) => !b.self)
  assert.ok(selfBoon, 'the self permanent Boon is still active')
  assert.equal(selfBoon!.permanent, true, 'the self Boon remains permanent')
  assert.equal(selfBoon!.estimatedMs, null, 'the self Boon has no countdown')

  assert.ok(petBoon, 'the pet Boon is active alongside the self Boon')
  assert.equal(petBoon!.cls, 'buff', 'the pet Boon is the same beneficial buff spell')
  assert.equal(petBoon!.disposition, 'charmed', 'the pet Boon is bound to the charmed pet')
  assert.notEqual(petBoon!.permanent, true, 'the pet-cast instance is NOT permanent')
  assert.equal(Math.round((petBoon!.estimatedMs ?? 0) / MIN), 6, 'pet Boon has its normal ~6-min DB estimate')

  // After the "worn off of an abhorrent" fade (00:54:07): the PET instance is gone, the
  // permanent SELF instance remains — the two are independent (Task #35).
  const fadeTs = tsOf('[Fri Jul 31 00:54:07 2026] x')
  const throughFade = lines.filter((l) => tsOf(l) > 0 && tsOf(l) <= fadeTs)
  const snapFade = replayBuffsWithDb(throughFade, fadeTs)
  const fadeBoons = snapFade.active.filter((a) => a.spell.toLowerCase().includes('boon of the garou'))
  assert.ok(!fadeBoons.some((b) => !b.self), 'the pet Boon is removed by its worn-off message')
  assert.ok(fadeBoons.some((b) => b.self && b.permanent), 'the permanent self Boon survives')
})

// ─────────────────────────────────────────────────────────────────────────────
// W10 — CAZIC-THULE SLOW (Task #35, the verification standard the user set).
// Raw: eqlog lines 919140 → 924080, Sat Aug 01. The user was fighting Cazic-Thule in The
// Plane of Fear. HAND-VERIFIED (read line-by-line from the real log):
//   20:46:05  You have entered The Plane of Fear - Solo 1 (Awakened).   (zone)
//   20:56:52  phoboplasm has been charmed.                              (the charmed pet)
//   21:01:40  You begin casting Shiftless Deeds IV.                     (a slow, RANKED)
//   21:01:46  You begin casting Shiftless Deeds IV.                     (recast)
//   21:01:50  Cazic-Thule slows down.                                   (the slow LANDED)
// "<Target> slows down." is the msg_cast_on_other shared by the enchanter slows (Forlorn
// Deeds / Languid Pace / Shiftless Deeds / Tepid Deeds / an NPC Rejuvenation). It is
// AMBIGUOUS across those, so the module resolves it to the one the player actually cast this
// session — Shiftless Deeds (cast twice, seconds earlier). CRITICAL (the user's standard):
// the target 'Cazic-Thule' comes FROM THE MESSAGE, not inferred — so the active is
// message-bound to entity 'Cazic-Thule' with inferredTarget UNSET. (The window's earlier
// "Fright slows down." 20:46:53 / "Dread slows down." 20:51:43 are the same slow landing on
// other Fear mobs the pet was clearing; we assert the Cazic instance specifically.)
test('W10 Cazic-Thule slow: Shiftless Deeds bound BY MESSAGE to entity Cazic-Thule', () => {
  const lines = readFixture('w10-cazic-slow.log')
  const slowTs = tsOf('[Sat Aug 01 21:01:50 2026] x')
  const through = lines.filter((l) => tsOf(l) > 0 && tsOf(l) <= slowTs + 1000)
  const snap = replayBuffsWithDb(through, slowTs + 1000)

  // Exactly one Shiftless Deeds instance, on Cazic-Thule, by MESSAGE (not inferred).
  const sds = snap.active.filter((a) => a.spell.toLowerCase().includes('shiftless'))
  assert.equal(sds.length, 1, 'a single Shiftless Deeds instance (the message replaced the cast-timing guess)')
  const sd = sds[0]
  assert.equal(sd.cls, 'debuff', 'Shiftless Deeds is a debuff (spell property: Detrimental)')
  assert.equal(sd.self, false, 'a debuff is never the player’s own buff')
  assert.equal(sd.target, 'Cazic-Thule', 'bound to the entity the MESSAGE named')
  assert.equal(sd.messageDriven, true, 'applied by the exact "Cazic-Thule slows down." message')
  assert.notEqual(sd.inferredTarget, true, 'the target is message-bound, NOT inferred (user standard)')
  assert.notEqual(sd.provisional, true, 'confirmed by the landing message, not provisional')
  // Duration is Shiftless Deeds' authoritative DB value (2m30s), not another candidate's.
  assert.equal(Math.round((sd.estimatedMs ?? 0) / 1000), 150, 'Shiftless Deeds DB duration ~2m30s')
})
