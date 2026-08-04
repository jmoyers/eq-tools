// PROC VISIBILITY (docs/plans/proc-visibility.md §3) — the ledger announcing itself, and the
// drill rows that learned their rate.
//
// The bug this feature fixes is a DISCOVERABILITY bug, not an arithmetic one: proc data shipped
// behind the breakdown card's second tab and nothing on screen ever said so — the owner, who
// wrote the engine half, could not find it. So the assertions here are about two things:
//
//   1. THE NUMBERS ARE READ, NEVER RECOMPUTED. The tab badge and the summary strip must equal
//      the totals the panel behind them renders, so `procSummary` is pinned against
//      `overallParts` — the panel's own headline shaping — rather than against a hand-written
//      arithmetic of its own. A second rollup is the failure mode; equality is the test.
//   2. THE IS-A-PROC JOIN GOES BOTH WAYS. A poison Strike and a cast-less spell effect annotate;
//      an ordinary melee lane and a spell you actually CAST do not. The join is built in main
//      (procViews.ts) from the poison roster and procDetect's inference, so the fixture half
//      below is what proves the renderer never guesses.
//
// THE FIXTURES, replayed through the REAL parser + engine (w35 primes the coats that make the
// later windows slow-capable — the harness's established pattern):
//   w36-poison-slow-timing.log  the slow landings; 23 Strike procs + 27 Smiting Strike
//   w41-poison-asp-venom.log    the poison DAMAGE lane (Asp Venom Strike deals; Weakening does not)
//   w38-proc-ppm.log            no poison at all — three cast-less lanes and the slay group
//
// ONE MEASURED CORRECTION TO THE PLAN, written down rather than smoothed over: §3 asks for
// "Weakening/Venom drill rows". `Weakening Strike` is a SLOW — it deals no damage, so the meter
// has no row for it to annotate, in any fixture. It is in the ledger and absent from the drill,
// and the test pins that absence (see the last case) instead of inventing a row for it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { CombatEngine } from '../src/main/combat/engine'
import { formatPpm } from '../src/renderer/src/lib/formatRate'
import {
  hasProcActivity,
  overallParts,
  procAnnotationFor,
  procCount,
  procSummary,
  procTagIndex
} from '../src/renderer/src/features/combat/procRows'
import { flattenSkills } from '../src/renderer/src/features/combat/dashboardData'
import type { ProcsView, SegmentView, SourceView } from '../src/shared/combat'
import type { ProcRateView, ProcSkillTag } from '../src/shared/procAnalytics'

// ── synthetic half: the shaping, with every dimension controllable ───────────────────

/** A ProcsView with nothing in it. The shipped poison fields are all required, so an empty
 *  ledger has to be spelled out; `over` supplies only the dimension under test. */
function view(over: Partial<ProcsView> = {}): ProcsView {
  return {
    combatAtEngage: [],
    slowExpected: false,
    coats: [],
    strikes: [],
    strikeCount: 0,
    slowLands: 0,
    poisonDamage: [],
    poisonDamageTotal: 0,
    dispels: [],
    dispelCount: 0,
    stanceSwitches: 0,
    invocationSwitches: 0,
    ...over
  }
}

function rate(count: number, swings: number, over: Partial<ProcRateView> = {}): ProcRateView {
  return { count, swings, ...over }
}

/** One is-a-proc tag as main would emit it. An args object because five positional parameters
 *  blow `max-params`, and `activeSec` defaults to the window every case below shares. */
function tag(t: Omit<ProcSkillTag, 'activeSec'> & { activeSec?: number }): ProcSkillTag {
  return { ...t, activeSec: t.activeSec ?? 200 }
}

test('zero procs: a plain label and no strip — an empty selection grows no furniture', () => {
  const s = procSummary(view())
  assert.equal(s.count, 0)
  assert.equal(s.tab, 'Procs')
  assert.equal(hasProcActivity(view()), false)
  assert.equal(s.ppm, undefined)
  assert.equal(s.slow, undefined)
})

test('the badge and the strip: one number, two spellings, plus the slow only when it landed', () => {
  const overall = rate(12, 400, { ppmActive: 3.1, ppmWall: 2.8, per100Swings: 3 })
  const s = procSummary(view({ overall, slowLandMs: 4200 }))
  assert.equal(s.count, 12)
  // The rate is the app's ONE proc-rate spelling (formatRate.formatPpm), not a second one.
  assert.equal(s.ppm, formatPpm(3.1))
  assert.equal(s.tab, `Procs · 12 (${formatPpm(3.1)})`)
  assert.equal(s.strip, `Procs: 12 landed · ${formatPpm(3.1)} · slow landed +4.2s`)

  // No landing ⇒ the fragment is ABSENT, never "slow: none". "It did not land" and "no slow
  // poison was on" are different facts and the strip states neither.
  const noSlow = procSummary(view({ overall }))
  assert.equal(noSlow.slow, undefined)
  assert.equal(noSlow.strip, `Procs: 12 landed · ${formatPpm(3.1)}`)
})

test('a rate the engine withheld is ABSENT from the badge, never zero (law 5)', () => {
  // Below MIN_ACTIVE_SEC the engine sends no `ppmActive` at all. The COUNT is still exact, so
  // the badge shows it — a count with no rate, which is the honest shape.
  const s = procSummary(view({ overall: rate(3, 12) }))
  assert.equal(s.tab, 'Procs · 3')
  assert.equal(s.strip, 'Procs: 3 landed')
  assert.equal(s.ppm, undefined)
})

test('the count falls back to the shipped poison total when the engine sent no lanes', () => {
  // The pre-analytics payload shape: `strikes` only. The badge must still say something true.
  assert.equal(procCount(view({ strikes: [{ name: 'Weakening Strike', count: 4 }], strikeCount: 4 })), 4)
  assert.equal(procCount(view({ strikeCount: 4, overall: rate(9, 100) })), 9)
})

test('the is-a-proc join, BOTH directions', () => {
  const tags = [
    tag({
      skill: 'Asp Venom Strike',
      lane: 'Asp Venom Strike / Cobra Venom Strike',
      origin: 'poison',
      rate: rate(7, 400, { ppmActive: 2.1 })
    }),
    tag({ skill: 'Smiting Strike', lane: 'Smiting Strike', origin: 'spell', rate: rate(27, 400, { ppmActive: 8.6 }) })
  ]
  const idx = procTagIndex(tags)

  // TAGGED: the poison Strike and the cast-less spell effect, each with the LANE's own rate.
  assert.equal(procAnnotationFor(idx, 'Asp Venom Strike')?.text, `proc · ${formatPpm(2.1)}`)
  assert.equal(procAnnotationFor(idx, 'Smiting Strike')?.text, `proc · ${formatPpm(8.6)}`)

  // NOT TAGGED: an ordinary melee lane, and a spell with no ledger entry (i.e. one you cast).
  assert.equal(procAnnotationFor(idx, 'Melee'), undefined)
  assert.equal(procAnnotationFor(idx, 'Backstab'), undefined)
  assert.equal(procAnnotationFor(idx, 'Wrath'), undefined)

  // Names are dirty; keys fold (law 2).
  assert.equal(procAnnotationFor(idx, 'asp venom strike')?.text, `proc · ${formatPpm(2.1)}`)

  // The hover names the BASIS (count over active seconds) and, for a shared emote, says the
  // count is exact while the name is not.
  const hint = procAnnotationFor(idx, 'Asp Venom Strike')?.hint ?? ''
  assert.match(hint, /7 procs over 200s of active combat/)
  assert.match(hint, /Asp Venom Strike \/ Cobra Venom Strike/)
  // The inferred lane says it is inferred (law 1) and the poison lane does not claim to be.
  assert.match(procAnnotationFor(idx, 'Smiting Strike')?.hint ?? '', /INFERENCE/)
  assert.doesNotMatch(hint, /INFERENCE/)

  // No tags at all ⇒ nothing annotates. An absent payload is an absence, never a crash.
  assert.equal(procAnnotationFor(procTagIndex(undefined), 'Smiting Strike'), undefined)
})

test('a tagged row whose rate the engine withheld degrades to a bare `proc`', () => {
  const idx = procTagIndex([
    tag({ skill: 'Asp Venom Strike', lane: 'Asp Venom Strike', origin: 'poison', rate: rate(1, 8), activeSec: 4 })
  ])
  const a = procAnnotationFor(idx, 'Asp Venom Strike')
  assert.equal(a?.text, 'proc')
  // The fact that it IS a proc is still worth stating; the withheld division says why.
  assert.match(a?.hint ?? '', /No per-minute rate/)
})

// ── fixture half: the real windows ───────────────────────────────────────────────────

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function fixture(name: string): string[] {
  const p = join(FIXTURES, name)
  return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []
}

const W35 = fixture('w35-poison-coats.log') // PRIME: the coats the later windows fight under
const W36 = fixture('w36-poison-slow-timing.log')
const W38 = fixture('w38-proc-ppm.log')
const W41 = fixture('w41-poison-asp-venom.log')

const missing = (...w: string[][]): string | false =>
  w.some((f) => f.length === 0) ? 'fixture not present' : false

function replay(lines: string[]): { eng: CombatEngine; lastTs: number } {
  installSpellDb(loadSpellDb())
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

function segment(eng: CombatEngine, lastTs: number, id: string): SegmentView {
  const s = eng.snapshot(lastTs, { selectedId: id })
  assert.ok(s.selected, `segment ${id} resolves`)
  return s.selected
}

function you(seg: SegmentView): SourceView {
  const row = seg.entities.find((e) => e.id === 'you')
  assert.ok(row, `${seg.id} has a You row`)
  return row
}

/** Every drill row the level-2 list would draw, mapped to its proc annotation text (rows with
 *  no annotation are simply absent) — i.e. exactly what the user sees. */
function annotatedRows(seg: SegmentView): Map<string, string> {
  const idx = procTagIndex(seg.procs.procSkills)
  const out = new Map<string, string>()
  for (const r of flattenSkills(you(seg))) {
    const a = procAnnotationFor(idx, r.name)
    if (a) out.set(r.name, a.text)
  }
  return out
}

const sortedKeys = (m: Map<string, string>): string[] => [...m.keys()].sort()

test('W36: the badge, the strip and the drill rows all light from the same ledger', { skip: missing(W35, W36) }, () => {
  const { eng, lastTs } = replay([...W35, ...W36])
  const zone = segment(eng, lastTs, 'zone')
  const s = procSummary(zone.procs)

  // Hand-read: 23 poison Strike emotes + 27 cast-less Smiting Strike = 50 procs in the window.
  assert.equal(zone.procs.strikeCount, 23)
  assert.equal(s.count, 50)
  assert.match(s.tab, /^Procs · 50 \(/)
  assert.match(s.strip, /^Procs: 50 landed · /)
  assert.equal(hasProcActivity(zone.procs), true)

  // THE DRILL. Three lanes carry damage, so three rows learn a rate; the five weapon lanes and
  // the one spell the player actually CAST (Wrath — it has a cast line, so procDetect scores it
  // no proc) stay unannotated.
  const rows = annotatedRows(zone)
  assert.deepEqual(sortedKeys(rows), ['Asp Venom Strike', 'Blood Siphon Strike', 'Smiting Strike'])
  for (const plain of ['Melee', 'Backstab', 'Frenzy', 'Bash', 'Kick', 'Wrath']) {
    assert.equal(rows.get(plain), undefined, `${plain} is not a proc`)
  }
  for (const text of rows.values()) assert.match(text, /^proc · \d/)
})

test('W36: a fight that slowed carries the landing in its strip', { skip: missing(W35, W36) }, () => {
  const { eng, lastTs } = replay([...W35, ...W36])
  // e4 is the pull whose first Weakening Strike landed 31s in (hand-read off the fixture clock).
  const e4 = segment(eng, lastTs, 'e4')
  assert.equal(e4.procs.slowLandMs, 31_000)
  const s = procSummary(e4.procs)
  assert.equal(s.slow, 'slow landed +31.0s')
  assert.match(s.strip, / · slow landed \+31\.0s$/)

  // A pull with no landing says nothing about the slow at all (e3 opened slow-capable and never
  // landed one — "not landed" is the PANEL's headline, and the strip declines to restate it).
  const e3 = segment(eng, lastTs, 'e3')
  assert.equal(e3.procs.slowLandMs, undefined)
  assert.equal(procSummary(e3.procs).slow, undefined)
})

test('badge and strip EQUAL the panel totals — read, never recomputed', { skip: missing(W35, W36, W41) }, () => {
  for (const [prime, win] of [
    [W35, W36],
    [W35, W41]
  ]) {
    const { eng, lastTs } = replay([...prime, ...win])
    for (const id of ['zone', 'e2', 'e3', 'e4']) {
      const seg = segment(eng, lastTs, id)
      const p = seg.procs
      const s = procSummary(p)
      const lanes = p.lanes ?? []
      const overall = p.overall
      assert.ok(overall, `${id} carries an overall rate`)

      // The headline is an IDENTITY over the lanes the panel lists.
      assert.equal(s.count, lanes.reduce((n, l) => n + l.count, 0))
      assert.equal(s.count, overall.count)

      // …and the badge's two numbers are the panel's own headline cells, character for
      // character. `overallParts` is what ProcAnalytics draws; nothing here re-divides.
      const parts = overallParts(overall, seg.activeSec)
      assert.equal(parts[0].text, `${s.count} proc${s.count === 1 ? '' : 's'}`)
      assert.equal(s.ppm, parts[1].absent ? undefined : parts[1].text)
      if (s.ppm !== undefined) assert.equal(s.ppm, formatPpm(overall.ppmActive ?? -1))
    }
  }
})

test('W41: the venom row learns its rate; the slow lane has no row to learn one', { skip: missing(W35, W41) }, () => {
  const { eng, lastTs } = replay([...W35, ...W41])
  const zone = segment(eng, lastTs, 'zone')
  const rows = annotatedRows(zone)

  // Asp Venom Strike deals damage (2 hits, 106) so the meter has a row for it, and the row now
  // carries the LANE's rate — the ambiguous `Asp Venom Strike / Cobra Venom Strike` lane, whose
  // count is exact and whose name is not.
  const asp = procAnnotationFor(procTagIndex(zone.procs.procSkills), 'Asp Venom Strike')
  assert.match(asp?.text ?? '', /^proc · /)
  assert.match(asp?.hint ?? '', /Asp Venom Strike \/ Cobra Venom Strike/)
  assert.deepEqual(sortedKeys(rows), ['Asp Venom Strike', 'Blood Siphon Strike', 'Smiting Strike'])

  // THE MEASURED CORRECTION (see the header): Weakening Strike fired six times in this window
  // and is in the ledger — but it is a SLOW, it deals nothing, and the damage meter therefore
  // has no row for it. The join emits no tag rather than inventing a row.
  const weakening = (zone.procs.lanes ?? []).find((l) => l.name === 'Weakening Strike')
  assert.equal(weakening?.count, 6)
  assert.equal(
    (zone.procs.procSkills ?? []).some((t) => t.lane === 'Weakening Strike'),
    false
  )
  assert.equal(
    flattenSkills(you(zone)).some((r) => r.name === 'Weakening Strike'),
    false
  )
})

test('W38: the merged Slay Undead row learns the slay lane rate; no poison anywhere', { skip: missing(W38) }, () => {
  const { eng, lastTs } = replay(W38)
  const zone = segment(eng, lastTs, 'zone')
  assert.equal(zone.procs.strikeCount, 0)

  // A slay proc rides an ordinary weapon swing, so the aggregate's rows are weapon names and
  // the drill merges them into ONE row named after the lane. That merged row is what carries
  // the rate — the weapon rows underneath it are mostly ordinary swings and must not.
  const rows = annotatedRows(zone)
  assert.deepEqual(sortedKeys(rows), ['Condemnation of Nife', 'Dismiss Undead', 'Slay Undead', 'Smiting Strike'])
  assert.equal(rows.get('Melee'), undefined)
  assert.equal(rows.get('Backstab'), undefined)

  const slay = (zone.procs.procSkills ?? []).find((t) => t.skill === 'Slay Undead')
  assert.equal(slay?.origin, 'slay')
  assert.match(procAnnotationFor(procTagIndex(zone.procs.procSkills), 'Slay Undead')?.hint ?? '', /rides an ordinary weapon swing/)
})
