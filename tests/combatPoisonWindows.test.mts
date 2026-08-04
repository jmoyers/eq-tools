// Task #64 golden windows: ROGUE POISONS — coats, Strike procs, and time-to-slow.
//
// The user's ask: "add special combat support for rogue poisons … i want to see a line when
// rogue poisons land (specially slow) on the live combat scrolling graph. i want to measure
// the average time it takes to land slow if we have the correct poison applied. i want to be
// able to see the counts of spells (like the dispel variants and such)."
//
// WHAT THE LOG ACTUALLY SAYS (full sweep of eqlog_Primitive_freeport.txt, 2026-08-03) — this
// is the evidence every assertion below is pinned to, and several of these facts contradict
// the obvious design:
//
//   1. COATS ARE FOUR SLOTS, NOT ONE — three combat venoms plus one utility poison (the owner,
//      2026-08-04; eqlwiki's Rogue page and the per-venom pages state the mechanism). Combat
//      venoms STACK across their three mutually-exclusive LINES; utility poisons all share one
//      slot and replace one another. The log proves the stacking half — the last coat line
//      before the fights in W36 is Neurotoxic (a UTILITY poison), yet Asp Venom Strike, Blood
//      Siphon Strike and Stunning Strike all proc during them, because the three COMBAT venoms
//      coated eighteen minutes earlier were still up. A single-slot model would have to call
//      those procs impossible. The last section of this file pins the slot model itself, the
//      line-replacement rule, the death boundary, and the rows the UI draws from all of it.
//   2. `<mob>'s limbs move slower!` IS the slow, and it IS a rogue poison proc: it is
//      Weakening Strike's cast-on-other message and exactly one spell in the whole DB carries
//      it. But FOUR poisons grant Weakening Strike (Weakening / Binding / Neurotoxic /
//      Paralytic), so a landing proves "a rogue slow", never a specific poison.
//   3. `<mob> feels a bit dispelled.` IS NOT A ROGUE PROC. It is the Cancel Magic family's
//      landing line — eleven classes plus NPCs print it (eqlwiki), and the log has 1,386 of
//      them against ZERO `blessings wither` lines, which is what the rogue's own dispel proc
//      (Banishing Strike) would print. W37 pins that: the dispel lane is counted, labeled with
//      every candidate, and never attributed.
//   4. The third-person coat line is printed WITHOUT A SPACE — `Skandercoats their blades in
//      poison.` — on both occurrences in the log. The matcher has to tolerate that.
//
// THE WINDOWS (all cut by tests/extract-combat-fixtures.mjs, which routes through the shared
// scrub; each is documented line-by-line there):
//   w35-poison-coats.log        01:05:08 → 01:23:00  every coat the user has ever applied
//   w36-poison-slow-timing.log  01:23:01 → 01:26:47  the fights those coats were on for
//   w37-dispel-variants.log     00:38:18 → 00:40:02  the Djarn kill: 4 dispels, ZERO poison
//
// W35 is replayed as a PRIME for W36 (the harness's established pattern): the coat that makes
// every fight in W36 slow-capable is applied seven minutes before the first swing, so a
// combat-only window could not establish it — and "was a slow even possible in this pull?" is
// the entire denominator of the measurement.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { CombatEngine } from '../src/main/combat/engine'
import { COMBAT_POISON_LINES, MAX_COMBAT_COATS, POISONS, coatLineKey } from '../src/shared/poisons'
import { coatRows } from '../src/renderer/src/features/combat/procRows'
import type { LogEvent } from '../src/shared/logEvents'
import type { CombatSnapshot, ProcsView, SegmentView, TimelineView } from '../src/shared/combat'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function fixture(name: string): string[] {
  const p = join(FIXTURES, name)
  return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []
}

const W35 = fixture('w35-poison-coats.log')
const W36 = fixture('w36-poison-slow-timing.log')
const W37 = fixture('w37-dispel-variants.log')

/** Parse every line of a window, dropping the unclassified ones. */
function parseAll(lines: string[]): LogEvent[] {
  const out: LogEvent[] = []
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev && ev.kind !== 'unknown') out.push(ev)
  }
  return out
}

/** Replay lines through the real parser + engine; returns the engine at the last ingested ts. */
function replay(lines: string[]): { eng: CombatEngine; lastTs: number } {
  const eng = new CombatEngine()
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) {
      lastTs = ev.ts
      eng.ingestEvent(ev, false)
    }
  }
  return { eng, lastTs }
}

/** The named fight's SegmentView, resolved by id from a snapshot. */
function segment(eng: CombatEngine, lastTs: number, id: string): SegmentView {
  const s = eng.snapshot(lastTs, { selectedId: id, timeline: true })
  assert.ok(s.selected, `segment ${id} resolves`)
  return s.selected
}

function timeline(eng: CombatEngine, lastTs: number, id: string): TimelineView {
  const s = eng.snapshot(lastTs, { selectedId: id, timeline: true })
  assert.ok(s.timeline, `timeline ${id} exists`)
  return s.timeline
}

/** Fight ids newest-first, as the snapshot lists them (the zone summary excluded). */
function fightIds(snap: CombatSnapshot): string[] {
  return snap.segments.filter((s) => s.kind !== 'zone').map((s) => s.id)
}

// ── W35: the coat sequence (parser goldens) ─────────────────────────────────────────

test('W35 parser: every coat line in the log resolves to its exact poison, in order', { skip: W35.length === 0 && 'fixture not present' }, () => {
  installSpellDb(undefined) // the poison family is DB-FREE by design — prove it here.
  const coats = parseAll(W35).filter((e) => e.kind === 'poisonCoat')
  // Hand-read from the fixture (7 coat lines: 6 yours + 1 third-party). The prose is
  // idiosyncratic per poison — "in asp venom", "in a siphoning poison", "WITH a stunning
  // agent" — which is exactly why the parser matches a TABLE and not a pattern.
  assert.deepEqual(
    coats.map((c) => (c.kind === 'poisonCoat' ? `${c.who}|${c.poison}|${c.group}` : '')),
    [
      'you|Asp Venom|combat', // 01:05:10
      'you|Blood Siphon Venom|combat', // 01:05:13
      'you|Stunning Venom|combat', // 01:05:36
      'you|Neurotoxic Poison|utility', // 01:06:16
      'you|Mage Bane Poison|utility', // 01:06:47  (replaces Neurotoxic)
      'you|Neurotoxic Poison|utility', // 01:16:29  (replaces Mage Bane)
      // 01:19:30 — ANOTHER PLAYER, and the game prints it with no space after the name. The
      // generic form deliberately hides which poison, so 'unknown' is the honest answer.
      'Skander|unknown|unknown'
    ]
  )
})

test('W35 parser: both dry lines are UTILITY, and the activate lines stay AA activations', { skip: W35.length === 0 && 'fixture not present' }, () => {
  installSpellDb(undefined)
  const evs = parseAll(W35)
  const dries = evs.filter((e) => e.kind === 'poisonDry')
  // `The poison dries from the blade.` ×2 (01:06:47 and 01:16:29). Both are the UTILITY
  // wears-off line — the combat family says "The venom drips away.", which the whole log
  // never prints. Both land in the SAME SECOND as the coat that replaced them, so every
  // observed dry in this log is a replacement, not an expiry.
  assert.equal(dries.length, 2)
  assert.ok(dries.every((d) => d.kind === 'poisonDry' && d.group === 'utility'))

  // The `You activate <X>.` lines are NOT folded into the coat: they are the item click, and
  // 3 of the 6 coats in the whole log have no activate line at all, so the coat line is the
  // complete signal and the activate stays what it always was.
  const activates = evs.filter((e) => e.kind === 'aaActivate').map((e) => (e.kind === 'aaActivate' ? e.name : ''))
  assert.deepEqual(activates, [
    'Asp Venom',
    'Blood Siphon Venom',
    'Stunning Venom',
    'Neurotoxic Poison',
    'Mage Bane Poison',
    'Neurotoxic Poison'
  ])
})

test('W35 engine: utility is ONE slot; combat venoms STACK and a utility dry never clears them', { skip: W35.length === 0 && 'fixture not present' }, () => {
  installSpellDb(undefined)
  const { eng, lastTs } = replay(W35)
  const coat = eng.snapshot(lastTs).poison.coat
  // Six coats in, the state is the three combat venoms (all still up — nothing dried them)
  // plus the LAST utility poison only. Mage Bane is gone: Neurotoxic replaced it at 01:16:29.
  assert.equal(coat.utility?.poison, 'Neurotoxic Poison')
  assert.equal(coat.utility?.sinceTs, Date.parse('Aug 03 2026 01:16:29'))
  assert.deepEqual(coat.combat.map((c) => c.poison), ['Asp Venom', 'Blood Siphon Venom', 'Stunning Venom'])
})

// ── W36: procs + time-to-slow ───────────────────────────────────────────────────────

test('W36 parser: every Strike emote resolves, and the two SHARED emotes stay ambiguous', { skip: W36.length === 0 && 'fixture not present' }, () => {
  installSpellDb(undefined)
  const procs = parseAll(W36).filter((e) => e.kind === 'poisonProc')
  const byStrike = new Map<string, number>()
  for (const p of procs) {
    if (p.kind !== 'poisonProc') continue
    byStrike.set(p.candidates.join('/'), (byStrike.get(p.candidates.join('/')) ?? 0) + 1)
  }
  // Hand-counted from the fixture's raw emote lines (grep, no engine). All four ACTIVE
  // poisons are represented — the utility Neurotoxic's two procs plus the three combat
  // venoms' — which is the two-slot model's whole point.
  assert.deepEqual(Object.fromEntries([...byStrike].sort()), {
    'Asp Venom Strike/Cobra Venom Strike': 7, // "screams as poison burns their veins!"
    'Blood Siphon Strike/Blood Draw Strike': 7, // "begins to bleed profusely!"
    'Befuddling Strike': 3, // "stumbles, clutching their head!"
    'Stunning Strike': 3, // "begins to sway!"
    'Weakening Strike': 3 // "'s limbs move slower!"  ← the slow
  })
  // The slow is the ONE emote with a single owner, which is why it can be timed at all.
  const slows = procs.filter((p) => p.kind === 'poisonProc' && p.effect === 'slow')
  assert.equal(slows.length, 3)
  assert.ok(slows.every((p) => p.kind === 'poisonProc' && p.candidates.length === 1))
  assert.deepEqual(
    slows.map((p) => (p.kind === 'poisonProc' ? p.target : '')),
    ['an elemental warrior', 'a rock golem', 'a rock golem']
  )
})

test('W36 engine: TIME TO SLOW, hand-read from the fixture clock', { skip: W35.length === 0 || W36.length === 0 ? 'fixture not present' : false }, () => {
  installSpellDb(undefined)
  const { eng, lastTs } = replay([...W35, ...W36])
  const snap = eng.snapshot(lastTs, { maxSegments: 50 })
  // FOUR encounters across the two windows, newest first. e1 lives in W35 (a sand scarab at
  // 01:09:26, killed while MAGE BANE was the utility coat) and is the load-bearing NEGATIVE
  // case: same session, same combat venoms, but no slow-capable poison on.
  assert.deepEqual(fightIds(snap), ['e4', 'e3', 'e2', 'e1'])

  const t = (clock: string): number => Date.parse(`Aug 03 2026 ${clock}`)

  // e1 — 01:09:26, Mage Bane coated. Mage Bane grants Befuddling + Banishing Strike, NOT
  // Weakening Strike, so no slow was possible and the fight must say so rather than reporting
  // "not landed" (which would blame the dice for a loadout choice).
  const e1 = segment(eng, lastTs, 'e1').procs
  assert.equal(e1.coatAtEngage?.poison, 'Mage Bane Poison')
  assert.equal(e1.slowExpected, false)
  assert.equal(e1.slowLandMs, undefined)
  assert.equal(e1.strikeCount, 0)

  // e2 — engage 01:23:13 (the first outgoing damage, on an elemental warrior), slow landed
  // 01:24:29 → 76.0s. Read straight off the two timestamps in the fixture.
  const e2 = segment(eng, lastTs, 'e2').procs
  assert.equal(e2.coatAtEngage?.poison, 'Neurotoxic Poison')
  assert.equal(e2.slowExpected, true)
  assert.equal(e2.slowLands, 1)
  assert.equal(e2.slowLandMs, t('01:24:29') - t('01:23:13'))
  assert.equal(e2.slowLandMs, 76_000)

  // e3 — a 32s crusader pull with the SAME coat on and NO slow. This is the sample that must
  // never be quietly dropped (which would flatter the average) nor folded in as a zero (which
  // would wreck it).
  const e3 = segment(eng, lastTs, 'e3').procs
  assert.equal(e3.slowExpected, true)
  assert.equal(e3.slowLands, 0)
  assert.equal(e3.slowLandMs, undefined)

  // e4 — engage 01:25:32 (a Wrath nuke opens it), slow landed 01:26:03 → 31.0s, then again at
  // 01:26:19. `slowLandMs` is the FIRST landing; a refresh does not restart the clock.
  const e4 = segment(eng, lastTs, 'e4').procs
  assert.equal(e4.slowLands, 2)
  assert.equal(e4.slowLandMs, t('01:26:03') - t('01:25:32'))
  assert.equal(e4.slowLandMs, 31_000)
})

test('W36 engine: the rolling average NEVER counts a no-land pull as zero', { skip: W35.length === 0 || W36.length === 0 ? 'fixture not present' : false }, () => {
  installSpellDb(undefined)
  const { eng, lastTs } = replay([...W35, ...W36])
  const slow = eng.snapshot(lastTs).poison.slow

  // Only FINALIZED pulls that opened with a slow-capable coat enter the ring, so: e2 (landed
  // 76s) and e3 (no land). e1 never qualifies (Mage Bane), and e4 is still open at the end of
  // the window — a live fight has not finished failing to slow yet.
  assert.equal(slow.pulls, 2)
  assert.equal(slow.landed, 1)
  assert.equal(slow.noLand, 1)
  assert.equal(slow.avgMs, 76_000)

  // THE TRIPWIRE. Had e3 been averaged in as a 0, the mean would be 38s — a number that reads
  // twice as good as reality and describes a fight that never happened. Had it been dropped
  // entirely, `pulls` would equal `landed` and the reader would never know a pull failed.
  assert.notEqual(slow.avgMs, 38_000)
  assert.equal(slow.pulls, slow.landed + slow.noLand)
})

test('W36 engine: proc counts are IDENTITIES over the zone, and poison damage is a subset of outgoing', { skip: W35.length === 0 || W36.length === 0 ? 'fixture not present' : false }, () => {
  installSpellDb(undefined)
  const { eng, lastTs } = replay([...W35, ...W36])
  const zone = segment(eng, lastTs, 'zone').procs
  // W36 opens on `You have entered The Ruins of Old Paineel.`, so the LIVE zone session holds
  // exactly e2+e3+e4 — e1 belongs to the zone W35 was in and must not leak in.
  const fights = ['e2', 'e3', 'e4'].map((id) => segment(eng, lastTs, id).procs)
  const sum = (pick: (p: (typeof fights)[number]) => number): number => fights.reduce((n, p) => n + pick(p), 0)

  assert.equal(zone.strikeCount, sum((p) => p.strikeCount))
  assert.equal(zone.slowLands, sum((p) => p.slowLands))
  assert.equal(zone.poisonDamageTotal, sum((p) => p.poisonDamageTotal))
  assert.equal(zone.slowLands, 3) // the three `limbs move slower!` lines in the window
  assert.equal(zone.strikeCount, 23) // 7 + 7 + 3 + 3 + 3, per the parser golden above

  // A zone session spans many pulls and many coat swaps, so it has no single engage instant:
  // it reports the COUNTS and honestly declines the engage-relative measurements.
  assert.equal(zone.slowExpected, false)
  assert.equal(zone.slowLandMs, undefined)
  assert.equal(zone.coatAtEngage, undefined)

  // POISON DAMAGE IS A SECOND INDEX OVER DAMAGE ALREADY COUNTED, never a new total: every
  // poison lane must match the `You` source's own skill lane exactly. If this drifts, the
  // Procs tab has started inventing damage.
  for (const id of ['e2', 'e3', 'e4']) {
    const seg = segment(eng, lastTs, id)
    const you = seg.entities.find((e) => e.id === 'you')
    assert.ok(you, `${id} has a You row`)
    for (const lane of seg.procs.poisonDamage) {
      const skill = you.skills.find((s) => s.name === lane.name)
      assert.ok(skill, `${id}: poison lane ${lane.name} exists on the You row`)
      assert.equal(lane.total, skill.total, `${id}: ${lane.name} total matches the meter`)
      assert.equal(lane.count, skill.hits, `${id}: ${lane.name} hits match the meter`)
    }
    assert.ok(seg.procs.poisonDamageTotal <= seg.outTotal)
  }
})

test('W36 engine: MARKERS land on the fight clock (stance/invocation commits + slow landings)', { skip: W35.length === 0 || W36.length === 0 ? 'fixture not present' : false }, () => {
  installSpellDb(undefined)
  const { eng, lastTs } = replay([...W35, ...W36])

  // e2: `You begin reciting the inversion invocation.` at 01:23:46 (engage 01:23:13 → 33s),
  // then the slow at 76s. Both are POINT annotations — the invocation also keeps its pinned
  // SPAN, because "what was on" and "when did it change" are different questions.
  assert.deepEqual(
    timeline(eng, lastTs, 'e2').markers.map((m) => `${m.kind}|${m.label}|${m.t}`),
    ['invocation|inversion|33000', 'slow|Weakening Strike|76000']
  )
  // e4: both slow landings (01:26:03 → 31s, 01:26:19 → 47s) and the recovery invocation
  // (01:26:38 → 66s). The slow markers carry the mob they landed on, for the tooltip.
  const e4 = timeline(eng, lastTs, 'e4')
  assert.deepEqual(
    e4.markers.map((m) => `${m.kind}|${m.label}|${m.t}|${m.detail ?? ''}`),
    ['slow|Weakening Strike|31000|a rock golem', 'slow|Weakening Strike|47000|a rock golem', 'invocation|recovery|66000|']
  )
  // A marker is NOT a lane and NOT a damage instant: it must not appear in `events`, or the
  // DPS curve, the per-mob grouping and every lane total would inherit a zero-damage row.
  assert.ok(e4.events.every((e) => e.amount > 0 || e.outcome === 'miss' || e.outcome === 'resist'))
  assert.ok(!e4.lanes.some((l) => l.lane === 'Weakening Strike'))
})

// ── Marker survival through downsampling ────────────────────────────────────────────

test('markers survive DOWNSAMPLING intact — they are never strided', () => {
  installSpellDb(undefined)
  // A synthetic fight, because no real fixture fight is dense enough: the engine downsamples
  // above TIMELINE_BUDGET (2,000 instants) and the busiest span in these windows is far under
  // it. 40 swings/second for 75 seconds = 3,000 instants, comfortably over.
  const lines: string[] = []
  const stamp = (sec: number): string => {
    const d = new Date(Date.parse('Aug 03 2026 02:00:00') + sec * 1000)
    return `[Mon Aug 03 ${d.toTimeString().slice(0, 8)} 2026]`
  }
  lines.push(`${stamp(0)} You coat your blades in a neurotoxic poison.`)
  for (let s = 0; s < 75; s++) {
    for (let i = 0; i < 40; i++) lines.push(`${stamp(s)} You slash a rock golem for 10 points of damage.`)
    if (s === 10) lines.push(`${stamp(s)} You assume a berserker stance.`)
    if (s === 30) lines.push(`${stamp(s)} a rock golem's limbs move slower!`)
    if (s === 50) lines.push(`${stamp(s)} You begin reciting the inversion invocation.`)
    if (s === 60) lines.push(`${stamp(s)} You coat your blades in a paralytic poison.`)
  }
  const { eng, lastTs } = replay(lines)
  const tl = timeline(eng, lastTs, 'e1')

  assert.equal(tl.downsampled, true, 'the window is dense enough to trip the stride')
  assert.ok(tl.events.length < tl.rawCount, 'damage instants WERE strided')
  // …and every marker is still here, at its true offset. Uniform-striding a sparse series
  // would delete most of it, and a chart that draws one coat in five is worse than one that
  // draws none.
  assert.deepEqual(
    tl.markers.map((m) => `${m.kind}|${m.label}|${m.t}`),
    [
      'stance|berserker|10000',
      'slow|Weakening Strike|30000',
      'invocation|inversion|50000',
      'coat|Paralytic Poison|60000'
    ]
  )
  // The coat AT ENGAGE is the one applied before the first swing; the mid-fight swap is a
  // marker + a `coats` entry, and it must NOT retroactively re-label the fight's engage state.
  const p = segment(eng, lastTs, 'e1').procs
  assert.equal(p.coatAtEngage?.poison, 'Neurotoxic Poison')
  assert.deepEqual(p.coats, [{ poison: 'Paralytic Poison', tMs: 60_000 }])
  assert.equal(p.stanceSwitches, 1)
  assert.equal(p.invocationSwitches, 1)
  assert.equal(p.slowLandMs, 30_000)
})

// ── W37: the dispel variants, and the poison model staying quiet ────────────────────

test('W37: dispel landings are COUNTED, labeled with every candidate, and never attributed', { skip: W37.length === 0 && 'fixture not present' }, () => {
  // DB-GATED, deliberately: a dispel lane exists only because the game printed a spell's own
  // landing message and the spell DB could name it. With no DB there is no lane — which is
  // honest (we would not know what landed) rather than a guess.
  installSpellDb(loadSpellDb())
  const { eng, lastTs } = replay(W37)
  const snap = eng.snapshot(lastTs, { maxSegments: 20 })
  const seg = segment(eng, lastTs, fightIds(snap)[0]).procs

  // Four `Efreeti Lord Djarn feels a bit dispelled.` lines (00:39:02, :07, :16, :24). The count
  // is exact; the NAME is not — that message tier belongs to Cancel Magic AND Phobocancel, so
  // both ride in the label and the lane is flagged ambiguous for the UI's `~` treatment.
  assert.deepEqual(seg.dispels, [{ name: 'Cancel Magic / Phobocancel', count: 4, ambiguous: true }])
  assert.equal(seg.dispelCount, 4)

  // THE POINT OF THIS WINDOW: it is 26 minutes BEFORE the first coat in the log. A poison
  // feature that lights up on a fight with no poison would be worthless, so everything
  // poison-shaped must be silent — and in particular the dispels must NOT be read as the
  // rogue's Banishing Strike (which would print `'s blessings wither!`; the log has none).
  assert.equal(seg.slowExpected, false)
  assert.equal(seg.slowLands, 0)
  assert.equal(seg.strikeCount, 0)
  assert.equal(seg.coatAtEngage, undefined)
  assert.equal(eng.snapshot(lastTs).poison.coat.utility, undefined)
  assert.deepEqual(eng.snapshot(lastTs).poison.coat.combat, [])
  assert.equal(eng.snapshot(lastTs).poison.slow.pulls, 0)

  installSpellDb(undefined) // leave the shared parser config as we found it
})

// ── THE FOUR SLOTS: three combat venoms + one utility poison ────────────────────────
//
// The owner's correction (2026-08-04): "you get 3 COMBAT poisons and 1 UTILITY poison." He is
// right, and the mechanism is not a slot counter the game enforces — it is the ROSTER. The
// five combat venoms form three mutually-exclusive LINES, each stated in the venom's own
// eqlwiki description:
//   Cobra Venom      "stacks with all other combat poisons, excluding Asp Venom, which this
//                     replaces."
//   Blood Draw Venom "stacks with all other combat poisons, except Blood Siphon Venom, which
//                     this ability replaces."
//   Stunning Venom   "stacks with all other combat poisons."   (no exception at all)
// ⇒ asp | blood | stunning, one member of each ⇒ 3 combat coats, plus the one utility slot.
//
// THE LOG CANNOT PROVE THE CAP and this file will not pretend it does: the character is level
// 45, both upgrade venoms are level 46, so the three venoms in every observed burst are simply
// every combat venom he owns. The wiki is the source; the log is consistent with it.

test('the roster IS the cap: three combat lines, and every combat venom sits on one', () => {
  assert.equal(MAX_COMBAT_COATS, 3)
  assert.deepEqual([...COMBAT_POISON_LINES].sort(), ['asp', 'blood', 'stunning'])
  for (const p of POISONS) {
    if (p.group === 'combat') assert.ok(p.line, `${p.name} declares a venom line`)
    // A utility poison declaring a line would be meaningless — they already share ONE slot.
    else assert.equal(p.line, undefined, `${p.name} is utility and declares no line`)
  }
  // The two shared-emote Strike pairs (law 3) sit on the SAME line each, which is what makes
  // an ambiguous lane attributable to whichever member is coated: only one can ever be on.
  assert.equal(coatLineKey('Asp Venom'), coatLineKey('Cobra Venom'))
  assert.equal(coatLineKey('Blood Siphon Venom'), coatLineKey('Blood Draw Venom'))
  assert.notEqual(coatLineKey('Asp Venom'), coatLineKey('Stunning Venom'))
})

test('a fourth venom does not stack — the upgrade REPLACES its own line, and only its own', () => {
  // Synthetic because the log has no Cobra/Blood Draw line to hand-read (level 46, he is 45).
  // Every coat message below is the DB's own msgCastOnYou, so the parser path is the real one.
  const { eng, lastTs } = replay([
    '[Mon Aug 03 02:00:00 2026] You coat your blades in a neurotoxic poison.',
    // A swing before the venoms, so the zone segment's window actually COVERS the spans below
    // (`spansOverlapping` is scoped to the segment, and a span that closed before it opened is
    // correctly none of its business).
    '[Mon Aug 03 02:00:01 2026] You slash a rock golem for 10 points of damage.',
    '[Mon Aug 03 02:00:03 2026] You coat your blades in asp venom.',
    '[Mon Aug 03 02:00:06 2026] You coat your blades in a siphoning poison.',
    '[Mon Aug 03 02:00:09 2026] You coat your blades with a stunning agent.',
    '[Mon Aug 03 02:00:12 2026] You coat your blades in cobra venom.',
    '[Mon Aug 03 02:00:15 2026] You slash a rock golem for 10 points of damage.'
  ])
  const coat = eng.snapshot(lastTs).poison.coat
  assert.equal(coat.utility?.poison, 'Neurotoxic Poison')
  // THREE, not four: Cobra took Asp's line. Under the old name-keyed stack this read
  // [Asp, Blood Siphon, Stunning, Cobra] — four concurrent venoms the game cannot give you.
  assert.deepEqual(coat.combat.map((c) => c.poison), ['Blood Siphon Venom', 'Stunning Venom', 'Cobra Venom'])
  assert.ok(coat.combat.length <= MAX_COMBAT_COATS)
  // The span timeline agrees, and says HOW it ended: no line printed Asp's end, so 'inferred'.
  const spans = eng.snapshot(lastTs, { selectedId: 'zone' }).selected?.procs.states ?? []
  const asp = spans.find((s) => s.key === 'asp venom')
  assert.equal(asp?.endEvidence, 'inferred')
  assert.equal(asp?.endTs, Date.parse('Aug 03 2026 02:00:12'))
  for (const key of ['blood siphon venom', 'stunning venom', 'neurotoxic poison', 'cobra venom']) {
    assert.equal(spans.find((s) => s.key === key)?.endEvidence, 'open', `${key} is still on`)
  }
})

test('your own death clears the blades — the wiki says so and the log corroborates it', () => {
  // eqlwiki (Rogue): poisons "remain active until class swap or death". The log corroborates
  // WITHOUT ever printing a dry line for it: `Your Paralytic Poison spell did not take hold.
  // (Blocked by Neurotoxic Poison.)` at 20:01:47 Aug 03, then — after the 21:01:40 death — the
  // same Paralytic coat lands cleanly at 21:15:23. Something removed Neurotoxic and no line
  // said so. Before this the slot state and the span timeline disagreed at that instant:
  // censorAll ended the spans while `coatUtility` kept naming a poison the corpse did not have.
  const { eng, lastTs } = replay([
    '[Mon Aug 03 02:00:00 2026] You coat your blades in a neurotoxic poison.',
    '[Mon Aug 03 02:00:03 2026] You coat your blades in asp venom.',
    '[Mon Aug 03 02:00:06 2026] You slash a rock golem for 10 points of damage.',
    '[Mon Aug 03 02:00:20 2026] You have been slain by a rock golem!'
  ])
  const coat = eng.snapshot(lastTs).poison.coat
  assert.equal(coat.utility, undefined)
  assert.deepEqual(coat.combat, [])
  // CENSORED, never 'observed': the game printed no dry line, so the end is where our knowledge
  // stops, not a fact about the poison (law 1).
  const spans = eng.snapshot(lastTs, { selectedId: 'zone' }).selected?.procs.states ?? []
  for (const s of spans.filter((x) => x.kind === 'coat')) {
    assert.equal(s.endEvidence, 'censored')
    assert.equal(s.endTs, Date.parse('Aug 03 2026 02:00:20'))
  }
})

test('a pull after a death is honestly slow-INCAPABLE — the stale coat used to say otherwise', () => {
  const { eng, lastTs } = replay([
    '[Mon Aug 03 02:00:00 2026] You coat your blades in a neurotoxic poison.',
    '[Mon Aug 03 02:00:05 2026] You slash a rock golem for 10 points of damage.',
    '[Mon Aug 03 02:00:20 2026] You have been slain by a rock golem!',
    '[Mon Aug 03 02:05:00 2026] You slash a sand scarab for 10 points of damage.'
  ])
  const snap = eng.snapshot(lastTs, { maxSegments: 20 })
  const ids = fightIds(snap)
  // The pre-death pull opened under Neurotoxic: a slow was possible there.
  assert.equal(segment(eng, lastTs, ids[ids.length - 1]).procs.slowExpected, true)
  // The post-death pull opened on bare blades: `slowExpected` must be false, or the Procs tab
  // reports "not landed" — blaming the dice — for a fight in which no slow could ever land.
  const after = segment(eng, lastTs, ids[0]).procs
  assert.equal(after.coatAtEngage, undefined)
  assert.deepEqual(after.combatAtEngage, [])
  assert.equal(after.slowExpected, false)
})


// ── what the UI draws from the four slots ───────────────────────────────────────────
//
// `coatRows` (renderer, pure) is the shaping the Procs tab renders and the reason this engine
// file reaches across into the renderer: the model above is only worth having if every slot
// reaches the screen. The Procs tab used to render all four coats as a single dim line of
// joined names, and the header pill named ONLY the utility slot — which is what the owner
// reported: "the combat tab is only showing one of them that's applied."

const COATED: ProcsView = {
  coatAtEngage: { poison: 'Neurotoxic Poison', sinceTs: 1_000 },
  combatAtEngage: [
    { poison: 'Asp Venom', sinceTs: 2_000 },
    { poison: 'Blood Siphon Venom', sinceTs: 3_000 },
    { poison: 'Stunning Venom', sinceTs: 4_000 }
  ],
  slowExpected: true,
  coats: [],
  // The ledger's own lane spelling, INCLUDING the shared-emote join (law 3): one emote,
  // two candidate Strikes.
  strikes: [
    { name: 'Weakening Strike', count: 3 },
    { name: 'Asp Venom Strike / Cobra Venom Strike', count: 5, ambiguous: true },
    { name: 'Blood Siphon Strike / Blood Draw Strike', count: 2, ambiguous: true }
  ],
  strikeCount: 10,
  slowLands: 3,
  poisonDamage: [],
  poisonDamageTotal: 0,
  dispels: [],
  dispelCount: 0,
  stanceSwitches: 0,
  invocationSwitches: 0
}

test('every coat gets its OWN row — all four, utility first, never just the one', () => {
  const rows = coatRows(COATED)
  assert.deepEqual(
    rows.map((r) => `${r.poison}|${r.group}`),
    [
      'Neurotoxic Poison|utility',
      'Asp Venom|combat',
      'Blood Siphon Venom|combat',
      'Stunning Venom|combat'
    ]
  )
  // The applied time rides through untouched: a coat routinely predates the segment it is
  // reported in (the w41 window's venoms went on eighteen minutes before its first swing).
  assert.deepEqual(rows.map((r) => r.sinceTs), [1_000, 2_000, 3_000, 4_000])
})

test('a row carries its own Strikes, and the SLOW carrier is the utility poison', () => {
  const rows = coatRows(COATED)
  const by = new Map(rows.map((r) => [r.poison, r]))

  // Neurotoxic grants Befuddling + Weakening. Befuddling never landed here and the row SAYS so
  // with a zero rather than dropping the Strike: "it was coated and it never fired" is an
  // answer, and hiding it makes an unlucky coat look like one that was never applied.
  assert.deepEqual(by.get('Neurotoxic Poison')?.strikes, [
    { name: 'Befuddling Strike', count: 0 },
    { name: 'Weakening Strike', count: 3 }
  ])

  // THE AMBIGUOUS LANES RESOLVE HERE, and only because of the line model: `Asp Venom Strike /
  // Cobra Venom Strike` is one emote shared by two Strikes (law 3), but those two venoms sit on
  // ONE line and cannot both be coated — so with Asp up, the lane is Asp's.
  assert.deepEqual(by.get('Asp Venom')?.strikes, [{ name: 'Asp Venom Strike', count: 5 }])
  assert.deepEqual(by.get('Blood Siphon Venom')?.strikes, [{ name: 'Blood Siphon Strike', count: 2 }])
  assert.deepEqual(by.get('Stunning Venom')?.strikes, [{ name: 'Stunning Strike', count: 0 }])

  // ONLY the utility poison can carry the slow — every Weakening-Strike granter in the roster
  // is a utility poison, which is exactly why `slowExpected` keys off the utility slot alone.
  assert.deepEqual(rows.filter((r) => r.slowCarrier).map((r) => r.poison), ['Neurotoxic Poison'])
})

test('coats with no utility poison still produce rows — the case that rendered as NOTHING', () => {
  // The owner's own loadout after a death or a fresh log-in: three venoms, no utility poison.
  // The header pill returned null for exactly this shape.
  const rows = coatRows({ ...COATED, coatAtEngage: undefined, slowExpected: false })
  assert.equal(rows.length, 3)
  assert.ok(rows.every((r) => r.group === 'combat'))
  assert.ok(!rows.some((r) => r.slowCarrier), 'no venom can proc a slow')
  // And a selection with nothing coated is genuinely empty — never a placeholder row.
  assert.deepEqual(coatRows({ ...COATED, coatAtEngage: undefined, combatAtEngage: [] }), [])
})

test('an UNKNOWN coat is listed without being classified or given Strikes', () => {
  // The coat line demonstrably fired but refused to name the poison. The blades are coated —
  // that is true and shown — but nothing may be claimed about what is on them.
  const rows = coatRows({ ...COATED, coatAtEngage: { poison: 'unknown', sinceTs: 9 }, combatAtEngage: [] })
  assert.deepEqual(rows, [
    { key: 'unknown|9|0', poison: 'unknown', group: 'unknown', sinceTs: 9, strikes: [], slowCarrier: false }
  ])
})
