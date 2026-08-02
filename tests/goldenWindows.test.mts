// GOLDEN-WINDOW WORLD-MODEL TESTS (Task #33).
//
// The user saw the Buffs tab display days-old "active" buffs on long-dead pets while
// their real self buffs were invisible, and mandated: unit tests built on HAND-EXAMINED
// time spans of the real log, asserting a plausible world model. This file is that
// deliverable.
//
// METHODOLOGY (documented here + in AGENTS.md for future changes):
//   1. A real log window is located and READ LINE-BY-LINE by a human (see each test's
//      header — raw line refs into eqlog_Primitive_freeport.txt + the verified sequence).
//   2. The window is extracted verbatim (chat/spam trimmed) into tests/fixtures/*.log via
//      tests/extract-fixtures.mjs. Fixtures are committed — they are the user's own log.
//   3. Some windows are PRIMED with an earlier real excerpt (tests/fixtures/*-priming.log)
//      that warms the learned classifier / everFaded set BEFORE the window — exactly what
//      the full-log replay does ahead of the live tail in production. A golden window is a
//      slice; priming gives it the history the real app already has.
//   4. The window is replayed through the REAL parser + BuffsModule and the resulting
//      world model (active buffs w/ target + class, mined stats) is asserted.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFixture, replayBuffs, findActive, activeNames, tsOf } from './harness.mts'

const MIN = 60_000

// ─────────────────────────────────────────────────────────────────────────────
// W1 — CURRENT PERMAFROST SESSION (the user's ground truth).
// Raw: eqlog lines 895658 (zone 19:02:06) → 905700 (19:56:13), Sat Aug 01.
// HAND-VERIFIED sequence:
//   19:51:10  You have entered The Permafrost Caverns - Solo 4 (Refined).  (zone)
//   19:51:33  You begin casting Swift Like the Wind I.
//   19:51:35  You feel much faster.        ← SELF landing emote (2s later) ⇒ SELF cast
//   19:54:48  You begin casting Tashani.   (a debuff)
//   19:54:56  an ice giant has been charmed.
//   19:55:52  Your Allure spell has worn off of an ice giant.   (uncharm)
//   19:55:59  an ice giant has been charmed.                    (re-charm)
// "You feel much faster." recurs adjacent to Swift casts within the session (19:23:50,
// 19:51:35), so it is a RECOGNIZED landing emote by 19:51:35 → the 19:51:33 cast binds
// SELF even though a charmed pet is (later) live. This is the exact fix for the user's
// complaint: a real self buff, previously invisible because every cast was assumed to be
// on the charmed pet, now shows as SELF.
// EXPECT at ~19:56: Swift Like the Wind active, SELF target; and ZERO pet-buff actives
// carried over from before this session (no Gibober/Xeneker/Zektik/Jeber/Gebantik).
test('W1 current session: self Swift Like the Wind active, no stale pre-session pet buffs', () => {
  const lines = readFixture('w1-current-session.log')
  const observe = tsOf('[Sat Aug 01 19:56:00 2026] x') // user's ground-truth instant
  const snap = replayBuffs(lines, observe)

  const swift = findActive(snap, 'swift like the wind')
  assert.ok(swift, 'Swift Like the Wind should be an active buff at ~19:56')
  assert.equal(swift!.cls, 'self', 'Swift here is a SELF buff (self landing emote)')
  assert.equal(swift!.disposition, 'self', 'bound disposition is self')
  assert.equal(swift!.target ?? undefined, undefined, 'a self buff has no target chip')
  assert.equal(swift!.provisional, undefined, 'confirmed, not provisional, by 19:56')

  // Swift landed 19:51:33 → elapsed ~4.5m at 19:56 (loose — the user reported ~11m
  // REMAINING on the real 15m self-buff; the mined estimate is imperfect, but the
  // active + self-target facts are the assertion that matters).
  const elapsedMin = (observe - swift!.startedTs) / MIN
  assert.ok(elapsedMin > 4 && elapsedMin < 6, `Swift elapsed ~4.5m, got ${elapsedMin.toFixed(1)}m`)

  // ZERO stale pet buffs from before this session.
  for (const stale of ['intensify death', 'clarity', 'spinechiller']) {
    assert.ok(!activeNames(snap).includes(stale), `no stale "${stale}" active from a prior session`)
  }
  // No active older than an hour (the "287h" class is impossible now).
  for (const a of snap.active) {
    if (a.provisional) continue
    assert.ok(observe - a.startedTs < 60 * MIN, `no hours-old active (${a.spell})`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// W2 — XENEKER DEATH (finding #4: a retired entity drops its actives + censors opens).
// Raw: eqlog lines 159640 → 167260, Mon Jul 20. Primed with the single real Intensify
// Death fade (line 97684, Jul 19) so it's a KNOWN pet buff (everFaded + class 'pet').
// HAND-VERIFIED sequence:
//   19:52:31  You begin casting Intensify Death.   (pet buff; pet's name not yet known)
//   19:57:42  Xeneker told you, 'Attacking … Master.'   (Xeneker = your summoned pet)
//   …          (Intensify never fades — no "pet's Intensify Death worn off" after)
//   20:22:03  Xeneker has been slain by a wan ghoul knight!   (a DIFFERENT killer)
// Xeneker is a SUMMONED pet with a UNIQUE proper name (no hostile twin), so the slain-by-
// other line is unambiguously its real death. BEFORE 20:22:03 Intensify Death is active
// bound to Xeneker; AFTER, it is GONE + censored (no bogus multi-hour "287h" sample).
test('W2 Xeneker death: pet buff active before, censored + gone after the slain line', () => {
  const prime = readFixture('w2-priming.log')
  const lines = readFixture('w2-xeneker-death.log')

  // Reconstruct the before/after around the exact slain line by replaying to two cut
  // points (the death line's ts is the boundary).
  const slainTs = tsOf('[Mon Jul 20 20:22:03 2026] x')
  const before = lines.filter((l) => tsOf(l) > 0 && tsOf(l) < slainTs)
  const throughDeath = lines.filter((l) => tsOf(l) > 0 && tsOf(l) <= slainTs)

  const snapBefore = replayBuffs(before, slainTs - 1000, { prime })
  const intensBefore = findActive(snapBefore, 'intensify death')
  assert.ok(intensBefore, 'Intensify Death should be active on Xeneker before the slain line')
  assert.equal(intensBefore!.cls, 'pet', 'Intensify Death is a pet buff')

  const snapAfter = replayBuffs(throughDeath, slainTs, { prime })
  assert.ok(!findActive(snapAfter, 'intensify death'), 'Intensify Death gone after Xeneker dies')

  // Censored: the open cast was DROPPED, not paired into a bogus 30-min sample.
  const stat = snapAfter.stats['intensify death']
  assert.ok(!stat || stat.n === 0, 'no duration sample recorded from the unobserved fade')
})

// ─────────────────────────────────────────────────────────────────────────────
// W3 — PET SUCCESSION (finding #3: a new pet retires the previous pet's actives).
// Raw: eqlog lines 80900 → 97700, Sun Jul 19.
// HAND-VERIFIED sequence:
//   18:23:20  Gibober told you, '… Master.'          (Gibober = summoned pet)
//   18:40:05  You begin casting Intensify Death.      (on Gibober)
//   19:02:24  Jenann told you, '… Master.'            (Jenann = the SUCCESSOR pet)
//   19:41:58  Your pet's Intensify Death spell has worn off.   (Jenann's, ~62m after cast)
// Without the single-pet invariant, the 18:40:05 open cast pairs with the 19:41:58 fade →
// a bogus ~62-minute sample on a pet Jenann already replaced. Claiming Jenann at 19:02:24
// must RETIRE Gibober and CENSOR his open Intensify cast → no such sample.
test('W3 pet succession: successor claim retires prior pet, no 62-minute bogus sample', () => {
  const lines = readFixture('w3-pet-succession.log')
  const snap = replayBuffs(lines, tsOf('[Sun Jul 19 19:41:58 2026] x'))
  const stat = snap.stats['intensify death']
  // If a sample leaked, it would be the ~62-min Gibober→Jenann pairing. Assert none.
  assert.ok(!stat || stat.n === 0, 'Gibober→Jenann succession must not mine a duration sample')
  assert.ok(!findActive(snap, 'intensify death'), 'no lingering Intensify active after succession')
})

// ─────────────────────────────────────────────────────────────────────────────
// W4 — LOGOUT GAP (finding #5: a ≥30-min event-time gap clears ALL actives).
// Raw: eqlog lines 814800 → 815210, Sat Aug 01. Primed with a real Clarity fade
// (line 407668) so Clarity is a KNOWN buff.
// HAND-VERIFIED sequence:
//   02:15:04  You begin casting Clarity III.       (a buff; open, no fade before the gap)
//   02:52:14  … last event before the pause …
//   13:00:28  Welcome to EverQuest Legends!        (relog — a 608-MINUTE gap)
//   13:03:08  You have entered The Southern Desert of Ro.
// The Clarity cast before the logout must NOT replay as a live active after the 608-min
// gap: the gap boundary clears every active + censors opens.
test('W4 logout gap: a buff cast before a ≥30-min gap is cleared after relog', () => {
  const prime = readFixture('w4-priming.log')
  const lines = readFixture('w4-logout-gap.log')

  // The pause is 02:52:14 → 13:00:28. Cut BEFORE the pause (any pre-13:00 instant) to get
  // the pre-gap state, and observe at 02:53 (just after the last pre-pause event) so the
  // gap-clear hasn't fired yet.
  const preGapCut = tsOf('[Sat Aug 01 03:00:00 2026] x')
  const beforeGap = lines.filter((l) => tsOf(l) > 0 && tsOf(l) < preGapCut)
  const observeBefore = tsOf('[Sat Aug 01 02:53:00 2026] x')

  // Clarity is active/open right up to the gap (assert it was there to be cleared).
  const snapBefore = replayBuffs(beforeGap, observeBefore, { prime })
  assert.ok(findActive(snapBefore, 'clarity'), 'Clarity should be active just before the gap')

  // After the full replay (through the relog), the pre-gap buff is gone.
  const snapAfter = replayBuffs(lines, tsOf(lines[lines.length - 1]), { prime })
  assert.ok(!findActive(snapAfter, 'clarity'), 'Clarity cleared by the ≥30-min session gap')
  assert.equal(snapAfter.active.length, 0, 'no actives survive the logout gap')
})

// ─────────────────────────────────────────────────────────────────────────────
// W5 — CHARMED PET ZONED AWAY (finding: zone left-behind censors charmed-pet buffs).
// Raw: eqlog lines 486900 → 490943, Thu Jul 30. Primed (w5-priming.log) so Boon of the
// Garou / Tashani classify as PET buffs (the full-log verdict).
// HAND-VERIFIED sequence:
//   15:31:08  Your Boon of the Garou spell has worn off of an imp protector.  (pet fade)
//   15:43:53  an imp protector has been charmed.
//   15:43:56  an imp protector feels a healing touch.   ← PET landing emote names the pet
//   15:44:25  You begin casting Boon of the Garou.       (on the charmed imp)
//   15:50:54  You have entered The Lavastorm Mountains.  (zone — charmed pet LEFT BEHIND)
// A charmed pet cannot survive a zone, so its open pet buffs (Boon, Tashani) can never be
// observed fading → CENSORED + removed from the active display on the zone line.
test('W5 charmed pet zoned away: its pet buffs are censored + gone after the zone', () => {
  const prime = readFixture('w5-priming.log')
  const lines = readFixture('w5-charm-zone.log')
  const zoneTs = tsOf('[Thu Jul 30 15:50:54 2026] x')

  const before = lines.filter((l) => tsOf(l) > 0 && tsOf(l) < zoneTs)
  const snapBefore = replayBuffs(before, zoneTs - 1000, { prime })
  const boonBefore = findActive(snapBefore, 'boon of the garou')
  assert.ok(boonBefore, 'a pet buff (Boon) should be active on the charmed imp before the zone')
  assert.equal(boonBefore!.cls, 'pet', 'Boon of the Garou is a pet buff here')
  assert.equal(boonBefore!.disposition, 'charmed', 'bound to the charmed pet')

  const snapAfter = replayBuffs(lines, tsOf(lines[lines.length - 1]), { prime })
  assert.ok(!findActive(snapAfter, 'boon of the garou'), 'Boon censored + gone after the zone')
  // No charmed-disposition active survives the zone.
  for (const a of snapAfter.active) {
    assert.notEqual(a.disposition, 'charmed', `no charmed-pet buff survives a zone (${a.spell})`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// W6 — RANK PAIRING (finding #1: strip a trailing Roman rank so cast↔fade pair).
// Raw: eqlog lines 901690 → 903370, Sat Aug 01.
// HAND-VERIFIED sequence:
//   19:41:59  You begin casting Shiftless Deeds IV.                (RANKED cast)
//   19:45:53  Your Shiftless Deeds spell has worn off of Lady Vox. (RANK-LESS fade)
// The cast carries a rank ("IV"); the fade drops it. Only the rank-stripped canonical key
// makes them pair → a ~3m54s duration sample. Without the fix (name-keyed), "shiftless
// deeds iv" ≠ "shiftless deeds" and NO sample is mined.
test('W6 rank pairing: "Shiftless Deeds IV" cast pairs with "Shiftless Deeds" fade', () => {
  const lines = readFixture('w6-rank-pairing.log')
  const snap = replayBuffs(lines, tsOf(lines[lines.length - 1]))
  const stat = snap.stats['shiftless deeds']
  assert.ok(stat, 'Shiftless Deeds should be a mined spell (rank-merged key)')
  assert.equal(stat!.n, 1, 'exactly one cast→fade sample mined from the ranked/rankless pair')
  // 19:41:59 → 19:45:53 = 3m54s = 234s.
  const sec = Math.round((stat!.medianMs ?? 0) / 1000)
  assert.ok(sec >= 230 && sec <= 240, `sample ~3m54s (234s), got ${sec}s`)
})
