// CLASS-COMBO INFERENCE — the golden windows (docs/plans/class-combo-inference.md § 10 Wave 3).
//
// What is being pinned here is an INFERENCE, which makes the discipline matter more than usual,
// not less. EQ Legends runs up to three classes at once, the character level is the MINIMUM of
// their levels, and a loadout swap is NEVER logged — two independent full-log sweeps say so.
// Eleven `/who` rows in 1.1M lines are the only time the game names the loadout, and none of
// them is within 33 hours of the swap this log actually contains. So:
//
//   * CW1 pins the model against GROUND TRUTH — four real `/who` anchors, four combos.
//   * CW2 pins the headline inference — MNK out, ROG+BER in, across a swap nothing announced —
//     and pins the BOUNDARY NARROWING that makes it useful: 33.9 h from the level dings, 54 min
//     from the evidence shift.
//   * CW3 pins the model REFUSING to guess: {CLR,PAL} stays {CLR,PAL}.
//   * CW4 pins the model refusing to be fooled by one out-of-loadout cast.
//   * The full-log replay asserts INVARIANTS ONLY (the log grows by append — frozen numbers
//     rot), and it drives the epoch exactly as the app does so the wiped beta character is
//     excluded the same way.
//
// Every fixture is a real span of the user's log cut through the shared scrub
// (tests/extract-combo-fixtures.mjs), replayed through the REAL parser.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { parseEqTimestamp, parseEvent } from '../src/main/log/parser'
import { installCharacterName, installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { EpochDetector } from '../src/main/log/epochDetector'
import { ComboModule } from '../src/main/modules/combo'
import { classObservation } from '../src/main/modules/comboEvidence'
import { scoreSlots } from '../src/main/modules/comboScore'
import { levelDropBoundaries } from '../src/main/modules/comboIntervals'
import { comboAt, groupByCombo } from '../src/shared/comboIndex'
import {
  resolvedClasses,
  type ClassObservation,
  type ComboInterval,
  type ComboSnap
} from '../src/shared/classCombo'
import type { LogEvent } from '../src/shared/logEvents'
import { readFixture } from './harness.mts'

const LOG =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Primitive_freeport.txt'

/** The tailed character for every window here — the /who rule keys the self row on THIS name. */
const SELF = 'Primitive'

const at = (stamp: string): number => parseEqTimestamp(stamp)

/** Replay lines through the real parser into a fresh combo module. */
function replay(lines: string[], opts: { epochs?: boolean } = {}): ComboSnap {
  installSpellDb(loadSpellDb())
  installCharacterName(SELF)
  const mod = new ComboModule()
  mod.reset()
  const epoch = new EpochDetector()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    // The epoch event is SYNTHESIZED by the feeder, not parsed (index.ts hands it back onto
    // the same bus). Replaying it here is what makes the full-log run describe the CURRENT
    // character rather than the level-30 beta character wiped at launch.
    if (opts.epochs) {
      const boundary = epoch.observe(ev)
      if (boundary) mod.onEvent(boundary)
    }
    mod.onEvent(ev)
  }
  return mod.snapshot().state
}

/** Every observation a fixture yields, with clicky suppression applied exactly as the module
 *  applies it — the input the SCORER sees. */
function observationsOf(lines: string[]): ClassObservation[] {
  installSpellDb(loadSpellDb())
  installCharacterName(SELF)
  const out: ClassObservation[] = []
  let seq = 0
  let lastItem: number | null = null
  for (const raw of lines) {
    const ev: LogEvent | null = parseEvent(raw, seq++)
    if (!ev) continue
    if (ev.kind === 'itemActivate') {
      lastItem = ev.ts
      continue
    }
    const observation = classObservation(ev, lastItem)
    if (observation) out.push(observation)
  }
  return out
}

/** An interval's slots as `PAL/MNK/ENC`, ambiguity and all (`CLR|PAL`). */
const combo = (i: ComboInterval): string => i.slots.map((s) => s.candidates.join('|')).join('/')

// ---------------------------------------------------------------------------
// CW1 — four real /who anchors. GROUND TRUTH, not inference.
// ---------------------------------------------------------------------------

test('CW1: the four /who anchors each get their own interval, stated not inferred', () => {
  // Jul 28 14:00–20:45. Seven self rows, four distinct combos, and the tertiary slot unlocking
  // at level 10 (a 2-class row becomes a 3-class row) — the design's whole cardinality claim.
  const snap = replay(readFixture('cw1-who-anchored.log'))
  assert.deepEqual(
    snap.intervals.map(combo),
    ['CLR/BER', 'PAL/ENC', 'PAL/ROG/ENC', 'PAL/MNK/ENC'],
    'each stated loadout owns exactly one interval, in order'
  )
  for (const interval of snap.intervals) {
    for (const slot of interval.slots) {
      assert.equal(slot.provenance, 'who', `${interval.id} must be STATED, never inferred`)
      assert.equal(slot.confidence, 1, `${interval.id} slot confidence`)
      assert.equal(slot.candidates.length, 1, `${interval.id} slot must be resolved`)
    }
    // Arity IS the cardinality statement: 2 slots below level 10, 3 at/after it.
    assert.equal(interval.slots.length, interval.expectedSlots)
  }
  assert.deepEqual(
    snap.intervals.map((i) => i.expectedSlots),
    [2, 2, 3, 3],
    'the tertiary slot unlocks once and never closes again'
  )
  // The Jul 28 rogue excursion is dated by the REPEAT level ding (11 → 11, which a
  // strict-descent predicate misses) rather than by the three-hour /who gap around it.
  const excursion = snap.intervals[2]
  assert.equal(excursion.startReason, 'levelDrop')
  assert.equal(excursion.startLo, at('Tue Jul 28 15:51:40 2026'))
  assert.equal(excursion.startHi, at('Tue Jul 28 16:46:22 2026'))
})

// ---------------------------------------------------------------------------
// CW2 — the unlogged swap, and the boundary narrowing that makes it usable.
// ---------------------------------------------------------------------------

test('CW2: the Aug 2 swap is found with no /who row on the far side of it', () => {
  // Jul 31 16:00 → log end. The last /who (Jul 31 23:48) says PAL/MNK/ENC and the game never
  // speaks again; everything after the boundary is pure inference and is labelled as such.
  const snap = replay(readFixture('cw2-loadout-swap-aug2.log'))
  assert.equal(snap.intervals.length, 2, 'exactly one swap in this window')
  const [before, after] = snap.intervals

  assert.deepEqual(before.slots.map((s) => s.candidates[0]), ['PAL', 'MNK', 'ENC'])
  for (const slot of before.slots) assert.equal(slot.provenance, 'who')

  assert.deepEqual(
    [...resolvedClasses(after)].sort(),
    ['BER', 'PAL', 'ROG'],
    'MNK and ENC are out; ROG and BER are in'
  )
  for (const slot of after.slots) {
    assert.equal(slot.provenance, 'inferred', 'nothing after the swap was ever STATED')
    assert.ok(slot.confidence < 1, 'and nothing after it is certain')
  }
  // The evidence, named. These are the labels the whole inference rests on.
  const because = after.slots.flatMap((s) => s.because)
  for (const key of ['skill:Backstab', 'stance:berserker', 'skill:Frenzy']) {
    assert.ok(because.includes(key), `expected ${key} in the evidence, got ${because.join(', ')}`)
  }
})

test('CW2: the evidence shift NARROWS the swap from 33.9 hours to 54 minutes', () => {
  // THIS is the wave-2 correction, made a test. The level dings bracket the swap between the
  // last level-50 ding on Jul 31 and the level-11 ding on Aug 2 — 33.9 h of not-knowing. The
  // exclusive evidence dates it far better: the last MONK-only observation is a Tiger Claw
  // skill-up, the first observation of a class that was not there before is the berserker
  // stance. Both windows are asserted, separately, so the narrowing is provably a narrowing
  // and not an accident of never having looked at the wide one.
  const lines = readFixture('cw2-loadout-swap-aug2.log')
  const levels: { ts: number; level: number }[] = []
  installSpellDb(loadSpellDb())
  installCharacterName(SELF)
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev?.kind === 'level') levels.push({ ts: ev.ts, level: ev.level })
  }
  const drops = levelDropBoundaries(levels)
  assert.equal(drops.length, 1, 'one non-increasing ding in this window')
  assert.equal(drops[0].lo, at('Fri Jul 31 16:19:04 2026'))
  assert.equal(drops[0].hi, at('Sun Aug 02 02:13:34 2026'))
  assert.ok(drops[0].hi - drops[0].lo > 33 * 3_600_000, 'the honest level-ding window is 33.9 h')

  const boundary = replay(lines).intervals[1]
  assert.equal(boundary.startReason, 'evidenceShift')
  assert.deepEqual(boundary.startAlso?.includes('levelDrop'), true, 'the ding corroborates it')
  assert.equal(boundary.startLo, at('Sun Aug 02 01:00:24 2026'), 'last MONK-exclusive: Tiger Claw')
  assert.equal(boundary.startHi, at('Sun Aug 02 01:54:05 2026'), 'first arriving: berserker stance')
  assert.ok(boundary.startLo <= boundary.startTs && boundary.startTs <= boundary.startHi)
  // Inside the wide window, and much narrower than it — the point of the whole exercise.
  assert.ok(boundary.startLo > drops[0].lo && boundary.startHi < drops[0].hi)
  assert.ok(boundary.startHi - boundary.startLo < 60 * 60_000)
})

test('CW2: the post-swap interval SAYS it is over-determined rather than hiding the surplus', () => {
  // Two ENC-exclusive labels survive the swap — `Illusion: Dark Elf` and `Rampage I` (a
  // Berserker ability the wiki's spell pages carry as an Enchanter spell; see the wave notes).
  // ENC is ranked below BER on support and so falls outside the three slots, but a model that
  // silently dropped a fourth sustained class would be lying by omission. It is flagged.
  const after = replay(readFixture('cw2-loadout-swap-aug2.log')).intervals[1]
  assert.ok(after.startAlso?.includes('overDetermined'), 'the surplus class is declared')
})

// ---------------------------------------------------------------------------
// CW3 — the model refusing to guess.
// ---------------------------------------------------------------------------

test('CW3: a {CLR,PAL} span stays {CLR,PAL} — the model never picks PAL', () => {
  // Measured: CLR is NEVER exclusively evidenced in this log. Reckless Strength, Wrath, Smite,
  // Furor, Center, Courage, Daring, Stun and Holy Armor are all {CLR,PAL}, so the `[7 CLR/BER]`
  // anchor is genuinely unresolvable from casts alone.
  //
  // The assertion runs on the SCORER, not on the intervals: this span contains two /who rows
  // (the design assumed it contained none), and a /who row OVERRIDES inference by design
  // (§ 4.4) — so asking the intervals what they inferred would be asking a question the ground
  // truth already answered. The window is cut at the SECOND row, so what is scored is exactly
  // the `[7 CLR/BER]` era: BER is exclusively evidenced (Frenzy, the berserker stance) and CLR
  // is not evidenced exclusively anywhere, ever.
  const cut = at('Tue Jul 28 14:14:48 2026')
  const observations = observationsOf(readFixture('cw3-ambiguous-clr-pal.log')).filter(
    (o) => o.ts < cut
  )
  const slots = scoreSlots(observations, 2)
  const ambiguous = slots.find((s) => s.candidates.length > 1)
  assert.ok(ambiguous, `expected an ambiguous slot, got ${slots.map((s) => s.candidates.join('|')).join('/')}`)
  assert.deepEqual(ambiguous.candidates, ['CLR', 'PAL'])
  assert.equal(ambiguous.confidence, 0.6 / 2, 'we know the SET, not the member')
  assert.equal(ambiguous.provenance, 'inferred')
  // And it is never quietly collapsed to one of them.
  assert.equal(
    slots.some((s) => s.candidates.length === 1 && s.candidates[0] === 'CLR'),
    false,
    'CLR is not exclusively evidenced anywhere in this log — it must not resolve'
  )
})

// ---------------------------------------------------------------------------
// CW4 — one out-of-loadout cast is noise, not a class.
// ---------------------------------------------------------------------------

test('CW4: a lone out-of-loadout cast never admits its class', () => {
  // Aug 2 18:00–21:00, deep inside the PAL/ROG/BER period. It contains exactly one cast whose
  // spell page names a class that is not in the loadout — `Rampage I`, which spells.json maps
  // to {ENC}. (The design calls this window "the lone Chaos Flux"; wave 1 measured that no
  // player Chaos Flux cast exists on Aug 2 at all. Rampage I is the real instance.)
  const snap = replay(readFixture('cw4-stray-cast.log'))
  assert.equal(snap.intervals.length, 1, 'one stray cast is not a swap')
  const only = snap.intervals[0]
  assert.deepEqual([...resolvedClasses(only)].sort(), ['BER', 'PAL', 'ROG'])
  for (const slot of only.slots) {
    assert.equal(slot.candidates.includes('ENC'), false, 'ENC must not appear in any slot')
  }
})

test('CW4: item clickies contribute NO class evidence at all', () => {
  // The suppression rule, isolated. `Your <item> shimmers briefly.` is followed in the same
  // second by the cast the ITEM made; wave 1 measured that the design's sustain>=2 rule does
  // NOT reject those (post-swap ENC keeps 7 exclusive labels through clickies alone).
  const lines = [
    '[Sun Aug 02 19:20:00 2026] Your Djarn`s Amethyst Ring (Exaltation) shimmers briefly.',
    '[Sun Aug 02 19:20:00 2026] You begin casting Mesmerization.'
  ]
  installSpellDb(loadSpellDb())
  installCharacterName(SELF)
  const activate = parseEvent(lines[0], 0)
  assert.equal(activate?.kind, 'itemActivate')
  const cast = parseEvent(lines[1], 1)
  assert.equal(cast?.kind, 'castBegin')
  assert.equal(classObservation(cast!, activate!.ts), null, 'the clicky cast says nothing')
  // The SAME cast with no item activation in front of it is full evidence.
  const handCast = classObservation(cast!, null)
  assert.deepEqual(handCast?.candidates, ['ENC'])
  assert.equal(handCast?.source, 'cast')
  // …and one 2.5s later than the activation is a hand-cast again.
  const later = parseEvent('[Sun Aug 02 19:20:03 2026] You begin casting Mesmerization.', 2)
  assert.deepEqual(classObservation(later!, activate!.ts)?.candidates, ['ENC'])
})

test('a skill-up and a spell that SHARE a name resolve to different classes', () => {
  // classes.json's disputed[] rows, made executable. Frenzy is a BERSERKER skill and a
  // SHM/BST spell; Feign Death is a MONK skill and a NEC/SHD spell. Unioning the tables would
  // hand the Aug 2 monk evidence to NEC/SHD and destroy the one signal that dates the swap.
  installSpellDb(loadSpellDb())
  installCharacterName(SELF)
  const skillUp = parseEvent('[Sun Aug 02 00:57:55 2026] You have become better at Feign Death! (44)', 0)
  assert.deepEqual(classObservation(skillUp!, null)?.candidates, ['MNK'])
  const cast = parseEvent('[Sun Aug 02 00:57:55 2026] You begin casting Feign Death.', 1)
  assert.deepEqual(classObservation(cast!, null)?.candidates, ['NEC', 'SHD'])
  const frenzySkill = parseEvent('[Tue Jul 28 12:32:17 2026] You have become better at Frenzy! (9)', 2)
  assert.deepEqual(classObservation(frenzySkill!, null)?.candidates, ['BER'])
})

// ---------------------------------------------------------------------------
// The read seam — a time join, never a stamped field.
// ---------------------------------------------------------------------------

test('comboAt / groupByCombo partition timestamped rows across the real intervals', () => {
  const intervals = replay(readFixture('cw1-who-anchored.log')).intervals
  // A row inside each interval lands in that interval, and nowhere else.
  for (const interval of intervals) {
    const inside = interval.startTs + 1000
    assert.equal(comboAt(intervals, inside)?.id, interval.id)
  }
  assert.equal(comboAt(intervals, intervals[0].startTs - 1), null, 'before the first: unattributed')
  const rows = intervals.map((i) => ({ ts: i.startTs + 500, id: i.id }))
  const groups = groupByCombo(intervals, [{ ts: intervals[0].startTs - 5000, id: 'orphan' }, ...rows])
  assert.equal(groups[0].interval, null, 'an unattributable row is kept, never dropped')
  assert.deepEqual(
    groups.slice(1).map((g) => g.interval?.id),
    intervals.map((i) => i.id)
  )
  // Losslessness: every row we handed in came back out exactly once.
  assert.equal(groups.reduce((n, g) => n + g.rows.length, 0), rows.length + 1)
})

// ---------------------------------------------------------------------------
// User corrections — time-keyed, and outranked by the game itself.
// ---------------------------------------------------------------------------

test('a user correction owns an inferred span, and a /who row still outranks it', () => {
  installSpellDb(loadSpellDb())
  installCharacterName(SELF)
  const lines = readFixture('cw2-loadout-swap-aug2.log')
  const run = (corrections: Parameters<ComboModule['setCorrections']>[0]): ComboSnap => {
    const mod = new ComboModule()
    mod.reset()
    mod.setCorrections(corrections)
    let seq = 0
    for (const raw of lines) {
      const ev = parseEvent(raw, seq++)
      if (ev) mod.onEvent(ev)
    }
    return mod.snapshot().state
  }
  const swap = replay(lines).intervals[1]
  const corrected = run([
    { startTs: swap.startTs, endTs: null, classes: ['WAR', 'ROG', 'BER'], setAt: Date.now() }
  ])
  const after = corrected.intervals[corrected.intervals.length - 1]
  assert.deepEqual(after.slots.map((s) => s.candidates[0]), ['WAR', 'ROG', 'BER'])
  for (const slot of after.slots) assert.equal(slot.provenance, 'user')
  assert.equal(after.userLocked, true, 'a corrected interval is frozen against re-inference')
  // The /who-anchored interval is NOT overridden: correcting a span the game itself named is
  // the user being wrong, and the game just spoke (§ 4.4).
  const anchored = run([
    { startTs: corrected.intervals[0].startTs, endTs: null, classes: ['WAR'], setAt: Date.now() }
  ]).intervals[0]
  assert.deepEqual(anchored.slots.map((s) => s.candidates[0]), ['PAL', 'MNK', 'ENC'])
  for (const slot of anchored.slots) assert.equal(slot.provenance, 'who')
  // Pre-launch corrections describe the wiped beta character and are dropped on the way in.
  const mod = new ComboModule()
  mod.setCorrections([{ startTs: at('Sun Jul 19 09:00:00 2026'), endTs: null, classes: ['WIZ'], setAt: 1 }])
  assert.deepEqual(mod.getCorrections(), [])
})

// ---------------------------------------------------------------------------
// Full-log replay. INVARIANTS ONLY — the log grows by append, so frozen numbers rot.
// ---------------------------------------------------------------------------

test('full-log replay: the interval model holds together', { skip: !existsSync(LOG) }, () => {
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
  const snap = replay(lines, { epochs: true })
  const intervals = snap.intervals
  assert.ok(snap.ready, 'the class tables are present (an empty stub would fail here)')
  assert.ok(intervals.length >= 2, 'at least one boundary exists — the Aug 2 swap')

  let previousEnd = -Infinity
  for (const interval of intervals) {
    // Time-ordered, non-overlapping, and tiling: each interval starts exactly where the last
    // one ended, so a timestamp belongs to exactly one of them.
    if (previousEnd !== -Infinity) assert.equal(interval.startTs, previousEnd, `${interval.id} tiles`)
    previousEnd = interval.endTs ?? Infinity
    assert.ok(interval.startLo <= interval.startTs, `${interval.id} startLo`)
    assert.ok(interval.startTs <= interval.startHi, `${interval.id} startHi`)
    assert.equal(interval.slots.length, interval.expectedSlots, `${interval.id} slot count`)
    assert.ok(resolvedClasses(interval).length <= 3, `${interval.id} claims at most 3 classes`)
    for (const slot of interval.slots) {
      assert.ok(slot.candidates.length >= 1, `${interval.id} slot must name something`)
      assert.deepEqual(slot.candidates, [...new Set(slot.candidates)].sort(), 'sorted + deduped')
      assert.ok(slot.confidence >= 0 && slot.confidence <= 1, `${interval.id} confidence range`)
    }
  }
  assert.equal(intervals[intervals.length - 1].endTs, null, 'the last interval is open')

  // The epoch fired: nothing survives from the level-30 beta character wiped at launch.
  const LAUNCH = new Date(2026, 6, 28, 0, 0, 0, 0).getTime()
  assert.ok(intervals[0].startTs >= LAUNCH, 'the pre-launch character is not in the model')

  // The headline inference, as an invariant rather than a frozen combo: the CURRENT loadout
  // includes the Berserker, whose evidence (berserker stance + Frenzy skill-ups) has been
  // continuous since Aug 2 and is structurally invisible to cast evidence (BER has no spells).
  assert.ok(resolvedClasses(intervals[intervals.length - 1]).includes('BER'), 'BER is current')

  // Losslessness: every interval's evidence adds up to the whole retained stream.
  // MEASURED FLOOR at 2026-08-03 (1.13M lines): 17,775 observations survive the epoch and the
  // clicky suppression. A floor, never an equality — the log only grows (frozen-numbers rule).
  const total = intervals.reduce((n, i) => n + i.evidenceCount, 0)
  assert.ok(total >= 17_000, `expected a substantial observation stream, got ${total}`)
})

test('full-log replay: every /who row is reproduced by the interval covering it', { skip: !existsSync(LOG) }, () => {
  // The strongest possible check on the interval SLICING: for each of the 11 real anchors, the
  // interval that contains it must state exactly that loadout. A boundary placed one event too
  // late would strand a row in the previous interval and this would fail.
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
  const intervals = replay(lines, { epochs: true }).intervals
  installSpellDb(loadSpellDb())
  installCharacterName(SELF)
  let seq = 0
  let checked = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev?.kind !== 'selfWho') continue
    if (ev.ts < new Date(2026, 6, 28, 0, 0, 0, 0).getTime()) continue
    const interval = comboAt(intervals, ev.ts)
    assert.ok(interval, `no interval covers the /who row at ${ev.raw}`)
    assert.deepEqual(resolvedClasses(interval).join('/'), ev.classes.join('/'), ev.raw)
    checked++
  }
  assert.ok(checked >= 11, `expected at least the 11 known anchors, checked ${checked}`)
})
