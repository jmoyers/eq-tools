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
    assert.equal(a!.cls, 'self', `${needle} is a self buff`)
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
  assert.equal(valorBefore!.cls, 'self', 'Valor is a self buff')
  assert.equal(valorBefore!.durationSource, 'db', 'Valor duration is authoritative (DB)')
  // It has NOT yet exceeded its DB duration (removal is the message, not a timeout).
  assert.ok(wearTs - valorBefore!.startedTs < 54 * MIN, 'Valor removed before its 54-min DB window elapses')

  // AFTER the wear-off line, Valor is gone.
  const snapAfter = replayBuffsWithDb(lines, tsOf(lines[lines.length - 1]))
  assert.ok(!findActive(snapAfter, 'valor'), 'Valor cleared by its "Your valor fades." message')
})

// ─────────────────────────────────────────────────────────────────────────────
// W9 — PERMANENT ILLUSION (self-cast illusion = ∞; same spell on pet = normal).
// Raw: eqlog lines 635150 → 639850, Fri Jul 31. The Permanent Illusion AA is purchased at
// 00:40:53 (line 635160). Boon of the Garou is an ILLUSION-flagged spell (DB illusion:true).
// HAND-VERIFIED sequence (all AFTER the purchase):
//   00:44:37  You begin casting Boon of the Garou II.
//   00:44:38  You feel... strange.            → SELF-cast Boon → PERMANENT (illusion AA owned)
//   00:48:10  You begin casting Boon of the Garou II.
//   00:48:10  an abhorrent's face contorts …  → PET-cast Boon on the charmed abhorrent → NORMAL
//   00:54:07  Your Boon of the Garou spell has worn off of an abhorrent.  (the pet Boon fades)
// The model is NAME-KEYED (one active per spell), so the two casts occupy the slot in turn;
// we assert each in its own moment: after the self-cast Boon is PERMANENT; after the pet-cast
// it is a NORMAL pet buff (6-min DB estimate).
test('W9 Permanent Illusion: self-cast Boon is permanent, pet-cast Boon is normal', () => {
  const lines = readFixture('w9-permanent-illusion.log')
  const selfTs = tsOf('[Fri Jul 31 00:44:38 2026] x')
  const petTs = tsOf('[Fri Jul 31 00:48:10 2026] x')

  // After the SELF-cast (00:44:38, post-purchase): Boon is a PERMANENT self illusion.
  const throughSelf = lines.filter((l) => tsOf(l) > 0 && tsOf(l) <= selfTs)
  const snapSelf = replayBuffsWithDb(throughSelf, selfTs)
  const boonSelf = findActive(snapSelf, 'boon of the garou')
  assert.ok(boonSelf, 'self-cast Boon of the Garou should be active')
  assert.equal(boonSelf!.cls, 'self', 'self-cast Boon is a self buff')
  assert.equal(boonSelf!.permanent, true, 'self-cast illusion is PERMANENT (Permanent Illusion AA)')
  assert.equal(boonSelf!.estimatedMs, null, 'a permanent buff has no finite estimate/countdown')

  // After the PET-cast (00:48:10): Boon is now a NORMAL pet buff on the charmed abhorrent.
  const throughPet = lines.filter((l) => tsOf(l) > 0 && tsOf(l) <= petTs)
  const snapPet = replayBuffsWithDb(throughPet, petTs)
  const boonPet = findActive(snapPet, 'boon of the garou')
  assert.ok(boonPet, 'pet-cast Boon of the Garou should be active')
  assert.equal(boonPet!.cls, 'pet', 'pet-cast Boon is a pet buff')
  assert.notEqual(boonPet!.permanent, true, 'pet-cast illusion is NOT permanent')
  // Normal DB duration (~6 min for Boon of the Garou at max level).
  assert.equal(Math.round((boonPet!.estimatedMs ?? 0) / MIN), 6, 'pet Boon has its normal ~6-min DB estimate')

  // Right after the "worn off of an abhorrent" fade (00:54:07), the pet Boon is gone (the
  // model is name-keyed, so this asserts the pet-cast instance specifically, before a later
  // 00:57:58 pet-recast re-fills the slot).
  const fadeTs = tsOf('[Fri Jul 31 00:54:07 2026] x')
  const throughFade = lines.filter((l) => tsOf(l) > 0 && tsOf(l) <= fadeTs)
  const snapFade = replayBuffsWithDb(throughFade, fadeTs)
  const boonFade = findActive(snapFade, 'boon of the garou')
  assert.ok(!boonFade || boonFade.permanent === true, 'pet Boon removed by its worn-off message (only a permanent self Boon may remain)')
})
