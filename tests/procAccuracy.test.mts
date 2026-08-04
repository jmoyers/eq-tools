// PROC ACCURACY — the owner's 2026-08-04 report, pinned in both directions.
//
// The report was two screenshots of the same fight disagreeing with each other:
//
//   DEFECT 1  Banishing / Clumsiness / Stunning / Weakening Strike and Divine Stun I read
//             `0 landed · N resisted` in the combat drill, while the header of the panel BESIDE
//             them counted "90 slow landings this segment". Cause: an effect proc's LANDING is
//             a per-spell emote that names no spell (`<mob>'s limbs move slower!`) while its
//             RESIST names the spell like any other (`A wanderer resisted your Weakening
//             Strike!`), so the drill's lane was built out of resists alone and its `hits` were
//             the only "landed" it knew about. Real-log counts, sweep 2026-08-04:
//               Weakening Strike   562 emote landings vs  34 resists
//               Stunning Strike    430                vs  29
//               Clumsiness Strike  189                vs  37
//               Banishing Strike    19                vs   3
//             Every one of those rows was reporting a 100% resist rate.
//
//   DEFECT 2  Spells the owner casts appearing as `proc`. Measured per spell (procDetect's
//             header carries the full table), it is TWO shapes and neither is a window-width
//             problem — one is a HoT whose ticks are cast-detached, the other is the Quick Buff
//             AA delivering memorized buffs with no cast line at all.
//
// AND THE OTHER DIRECTION, which is why half this file is about spells that KEEP their tag:
// three of the six spells named in the report are genuine procs, and the log proves it by
// never once printing a cast for them. `Earthquake` (0 casts / 87 firings, an illusion proc),
// `Condemnation of Nife` (0 / 1,569, the Instrument of Nife aura) and `Dismiss Undead`
// (10 casts on Jul 20, then 388 firings over the following two weeks — the Ghoulbane weapon
// proc) must all survive any fix to defect 2, and w43 is here so a future "just demote anything
// with a cast line" cannot quietly delete them.
//
// FIXTURES: w42-effect-proc-resist.log and w43-earthquake-proc.log (cut by
// tests/extract-proc-fixtures.mjs, headers there), plus the shipped w7-quick-buff.log,
// w40-nife-buff.log and w35+w41 poison pair.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { CombatEngine } from '../src/main/combat/engine'
import { QUICK_BUFF_AA, QUICK_BUFF_BURST_MS, isCastlessHeal, noteCast, type RecentCasts } from '../src/main/combat/procDetect'
import { QUICK_BUFF, QUICK_BUFF_WINDOW_MS } from '../src/main/modules/buffsShapes'
import { flattenSkills } from '../src/renderer/src/features/combat/dashboardData'
import { landEvidence } from '../src/renderer/src/features/combat/landEvidence'
import { laneRows, ppmCell, procAnnotationFor, procTagIndex } from '../src/renderer/src/features/combat/procRows'
import { formatEntityText } from '../src/renderer/src/features/combat/copyText'
import type { ProcLaneView } from '../src/shared/procAnalytics'
import type { ProcsView, SegmentView, SkillView } from '../src/shared/combat'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function fixture(name: string): string[] {
  const p = join(FIXTURES, name)
  return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []
}

const W7 = fixture('w7-quick-buff.log')
const W35 = fixture('w35-poison-coats.log')
const W40 = fixture('w40-nife-buff.log')
const W41 = fixture('w41-poison-asp-venom.log')
const W42 = fixture('w42-effect-proc-resist.log')
const W43 = fixture('w43-earthquake-proc.log')

const missing = (...w: string[][]): string | false =>
  w.some((f) => f.length === 0) ? 'fixture not present' : false

function zone(lines: string[]): SegmentView {
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
  const s = eng.snapshot(lastTs, { selectedId: 'zone' }).selected
  assert.ok(s, 'the zone segment resolves')
  return s
}

/** The `You` drill row for one skill, as the panel flattens it. */
function drillRow(seg: SegmentView, name: string): SkillView {
  const you = seg.entities.find((e) => e.id === 'you')
  assert.ok(you, 'a You row exists')
  const row = flattenSkills(you).find((r) => r.name === name)
  assert.ok(row, `drill row ${name} exists`)
  return row
}

function laneNamed(p: ProcsView, name: string): ProcLaneView {
  const l = (p.lanes ?? []).find((x) => x.name === name)
  assert.ok(l, `lane ${name} is serialized`)
  return l
}

const hasLane = (p: ProcsView, name: string): boolean => (p.lanes ?? []).some((l) => l.name === name)

// ── DEFECT 1: the effect proc that lands without a damage line ───────────────────────

test('W42: a Strike that deals nothing reports its LANDINGS, not `0 landed`', { skip: missing(W42) }, () => {
  const seg = zone(W42)

  // Hand-read off the fixture: three Strikes that print an emote when they land, a resist line
  // when they do not, and never a damage line either way.
  const expected = [
    { name: 'Weakening Strike', lands: 3, resists: 4 },
    { name: 'Clumsiness Strike', lands: 4, resists: 3 },
    { name: 'Stunning Strike', lands: 5, resists: 3 }
  ]
  for (const e of expected) {
    const row = drillRow(seg, e.name)
    assert.equal(row.total, 0, `${e.name} deals no damage`)
    assert.equal(row.hits, 0, `${e.name} has no damage line to count`)
    assert.equal(row.lands, e.lands, `${e.name} landings`)
    assert.equal(row.resists, e.resists, `${e.name} resists`)

    // THE DEFECT, in the one string it was visible in. It used to read `0 landed · N resisted`.
    const ev = landEvidence(row)
    assert.equal(ev.landed, e.lands)
    assert.equal(ev.text, `0 dmg · ${e.lands} landed · ${e.resists} resisted`)
    // …and the resist rate is now over attempts, not over resists alone.
    assert.equal(Math.round(ev.resistPct ?? -1), Math.round((e.resists / (e.lands + e.resists)) * 100))
    assert.notEqual(Math.round(ev.resistPct ?? -1), 100)
  }
})

test('W42: the ledger row and the drill row are the SAME two counters', { skip: missing(W42) }, () => {
  const seg = zone(W42)
  // The disagreement the owner photographed: the Procs tab counted landings, the drill counted
  // resists, and neither knew about the other. Both halves are now on both rows.
  for (const name of ['Weakening Strike', 'Clumsiness Strike', 'Stunning Strike']) {
    const lane = laneNamed(seg.procs, name)
    const row = drillRow(seg, name)
    assert.equal(lane.count, row.lands, `${name}: the ledger's landings ARE the drill's`)
    assert.equal(lane.resisted, row.resists, `${name}: and the resists likewise`)
    assert.equal(Math.round(lane.resistPct ?? -1), Math.round(landEvidence(row).resistPct ?? -2))
  }
  // The rendered ledger row says it too, in the spelling the panel and the clipboard share.
  const rows = laneRows(seg.procs.lanes ?? [], seg.activeSec)
  assert.equal(rows.find((r) => r.name === 'Weakening Strike')?.resisted, '4 resists · 57% resist')
  // A lane nothing resisted carries no resist text at all — never a `0`.
  assert.equal(rows.find((r) => r.name === 'Smiting Strike')?.resisted, undefined)
})

test('W42: the pasted block carries the same two counters, not a 100% resist rate', { skip: missing(W42) }, () => {
  const seg = zone(W42)
  const you = seg.entities.find((e) => e.id === 'you')
  assert.ok(you)
  const text = formatEntityText(seg, you)
  const row = text.split('\n').find((l) => l.startsWith('Weakening Strike'))
  assert.ok(row, 'the Strike has a row in the pasted skill table')
  assert.match(text, /Landed/, 'the table grew a Landed column because a row has landings')
  assert.match(row, /\b3\b/, '3 landings')
  // 4 of 7 attempts = 57%, not 4 of 4.
  assert.match(row, /57%/)
  assert.doesNotMatch(row, /100%/)
})

test('W42: a damage-less Strike now gets the drill annotation it was denied', { skip: missing(W42) }, () => {
  const seg = zone(W42)
  const idx = procTagIndex(seg.procs.procSkills)
  const a = procAnnotationFor(idx, 'Weakening Strike')
  assert.ok(a, 'the row is annotated')
  assert.match(a.text, /^proc · /)
  assert.match(a.hint, /rogue poison Strike/)
})

test('W42: with NO landing evidence at all, the resist rate is withheld', { skip: missing(W42) }, () => {
  const seg = zone(W42)
  // `You begin casting Divine Stun I.` and `A forsaken revenant resisted your Divine Stun I!` in
  // the same second. Divine Stun deals no damage AND prints nothing when it lands — the spell is
  // an AA and has no landing message in the DB at all — so the log simply cannot say how often
  // it worked. One resist is everything there is.
  const row = drillRow(seg, 'Divine Stun I')
  assert.equal(row.hits, 0)
  assert.equal(row.lands, undefined, 'no landing evidence exists — ABSENT, never 0')
  assert.equal(row.resists, 1)

  const ev = landEvidence(row)
  assert.equal(ev.landed, 0)
  assert.equal(ev.resistPct, undefined, 'no denominator ⇒ no rate (law 5), never 100%')
  assert.equal(ev.text, '1 resisted')
  assert.match(ev.hint, /No landing of this spell is recorded/)

  // And it is NOT a proc: it has a cast line of its own, so procDetect never claimed it.
  assert.equal(hasLane(seg.procs, 'Divine Stun I'), false)
  assert.equal(procAnnotationFor(procTagIndex(seg.procs.procSkills), 'Divine Stun I'), undefined)
})

// ── DEFECT 2: cast-less shapes that are not procs ────────────────────────────────────

test('W42: a HoT tick 41 seconds past its cast is not a proc', { skip: missing(W42) }, () => {
  // `You begin casting Ethereal Cleansing.` at 23:02:02, ticks through 23:02:43 — 41s later,
  // more than three PROC_CAST_WINDOW_MS past it. The gate is the WORDING (`healed … over time`),
  // not the clock, because no window width can cover a HoT: its ticks are cast-detached exactly
  // the way a DoT's are, which is what the damage path's DoT gate has always said.
  const seg = zone(W42)
  assert.equal(hasLane(seg.procs, 'Ethereal Cleansing'), false)
})

test('the HoT parse: `over time` leaves the target alone and reaches the model', () => {
  const ev = parseEvent('[Mon Aug 03 23:01:25 2026] You healed Primitive over time for 102 hit points by Ethereal Cleansing.', 0)
  assert.equal(ev?.kind, 'heal')
  assert.ok(ev && ev.kind === 'heal')
  // The lazy target capture used to SWALLOW ` over time`, filing 752 real ticks under a phantom
  // entity called "Primitive over time".
  assert.equal(ev.target, 'Primitive')
  assert.equal(ev.amount, 102)
  assert.equal(ev.spell, 'Ethereal Cleansing')
  assert.equal(ev.overTime, true)

  // A direct heal is untouched, including the overheal and crit shapes.
  const direct = parseEvent('[Mon Aug 03 23:01:25 2026] You healed Primitive for 85 (107) hit points by Greater Healing. (Critical)', 1)
  assert.ok(direct && direct.kind === 'heal')
  assert.equal(direct.target, 'Primitive')
  assert.equal(direct.amount, 85)
  assert.equal(direct.rawAmount, 107)
  assert.equal(direct.crit, true)
  assert.equal(direct.overTime, undefined)
})

test('W7: a Quick Buff burst delivers buffs, and none of them is a proc', { skip: missing(W7) }, () => {
  // `You activate Quick Buff.` at 20:29:44, then Valor and Symbol of Pinzarn land at 20:29:46
  // with no `You begin casting` line for either. That AA re-applies the player's memorized buffs
  // and prints only their landings; across the whole log it accounts for 254 such landings over
  // six spells, every one inside five seconds of the activation.
  const seg = zone(W7)
  for (const name of ['Valor', 'Symbol of Pinzarn']) {
    assert.equal(hasLane(seg.procs, name), false, `${name} is a buff you cast, not a proc`)
  }
})

test('the Quick Buff gate is a HEAL gate, and its two constants are the buffs module’s', () => {
  // Spelled in procDetect rather than imported (buffsShapes imports back out of src/main/combat,
  // so the import would close a cycle) — so the equality is a test.
  assert.equal(QUICK_BUFF_AA, QUICK_BUFF)
  assert.equal(QUICK_BUFF_BURST_MS, QUICK_BUFF_WINDOW_MS)

  const recent: RecentCasts = new Map()
  const burst = 1_000_000
  const heal = (ts: number, overTime = false): boolean =>
    isCastlessHeal(recent, { spell: 'Symbol of Pinzarn', ts, overTime, quickBuffTs: burst })

  assert.equal(heal(burst + 1), false, 'inside the burst: a delivered buff, not a proc')
  assert.equal(heal(burst + QUICK_BUFF_BURST_MS), false, 'the boundary is inclusive')
  assert.equal(heal(burst + QUICK_BUFF_BURST_MS + 1), true, 'past it, the ordinary inference resumes')
  assert.equal(heal(burst - 1), true, 'a burst cannot reach backwards')
  assert.equal(heal(burst + 100_000, true), false, 'a HoT tick is refused whatever the burst says')

  // And an own cast still suppresses, which is the rule these two only add to.
  noteCast(recent, 'Symbol of Pinzarn', burst + 100_000)
  assert.equal(heal(burst + 100_001), false)
})

// ── THE OTHER DIRECTION: a true proc keeps its tag ───────────────────────────────────

test('W43: Earthquake is never cast in this log, so it stays a proc', { skip: missing(W43) }, () => {
  const seg = zone(W43)
  const quake = laneNamed(seg.procs, 'Earthquake')
  assert.equal(quake.origin, 'spell')
  assert.equal(quake.count, 11, 'eleven firings, in AoE bursts of up to four in one second')
  assert.equal(quake.directDamage, 2_534, 'hand-summed off the fixture: 74 + 10 × 246')
  // …and it is resisted like any other spell, which is how the lane learns its other half.
  assert.equal(quake.resisted, 1)
  // The window is full of hand-casts (Lay on Hands IX, four Greater Healings), and not one of
  // them becomes a lane — the detector is discriminating, not permissive.
  for (const cast of ['Lay on Hands IX', 'Greater Healing', 'Lay on Hands', 'Wrath']) {
    assert.equal(hasLane(seg.procs, cast), false, `${cast} has a cast line and is no proc`)
  }
})

// ── THE ADDENDUM: ppm over the SOURCE's window, or honestly flagged ──────────────────

test('a KNOWN COAT SPAN is the poison lane’s denominator', { skip: missing(W35, W41) }, () => {
  // w41 primed by w35 (the shipped pattern — the utility coat in force at the first swing was
  // applied 22 minutes before the window opens). Neurotoxic is coated for 148 of the segment's
  // 250 active seconds, and Weakening Strike can only fire while it is on.
  const seg = zone([...W35, ...W41])
  assert.equal(Math.round(seg.activeSec), 250)
  const slow = laneNamed(seg.procs, 'Weakening Strike')
  assert.equal(slow.count, 6)
  assert.equal(slow.rate.sourceName, 'Neurotoxic Poison')
  assert.equal(slow.rate.sourceAmbiguous, undefined)
  assert.equal(Math.round(slow.rate.sourceSec ?? -1), 148)
  // 6 procs over 148s = 2.43 ppm. Over the whole segment it would have read 1.44 — a 41%
  // understatement, and the exact error the addendum exists to remove.
  assert.equal(Math.round((slow.rate.ppmActive ?? 0) * 100), 243)

  // A Strike granted by TWO utility poisons sums their spans, and summing is a union here
  // because the utility slot holds one coat at a time — they cannot overlap.
  const befuddle = laneNamed(seg.procs, 'Befuddling Strike')
  assert.equal(befuddle.rate.sourceName, 'Neurotoxic Poison + Mage Bane Poison')
  assert.equal(Math.round(befuddle.rate.sourceSec ?? -1), 250)

  // The hover says which window it used.
  assert.match(ppmCell(slow.rate, seg.activeSec).hint, /Neurotoxic Poison’s own observed window \(148s\)/)
})

test('a KNOWN BUFF SPAN is the aura-granted lane’s denominator', { skip: missing(W40) }, () => {
  // The catalog's one entry: `Instrument of Nife` grants `Condemnation of Nife`. The span only
  // exists with the spell DB installed (a buff landing is resolved from a message through the
  // DB's candidate table), exactly as in the real app.
  installSpellDb(loadSpellDb())
  const seg = zone(W40)
  const nife = laneNamed(seg.procs, 'Condemnation of Nife')
  assert.equal(nife.rate.sourceName, 'Instrument of Nife')
  assert.equal(nife.rate.sourceAmbiguous, undefined)
  assert.equal(Math.round(nife.rate.sourceSec ?? -1), 273, 'the aura was down for the first 7s')
  assert.equal(Math.round(seg.activeSec), 280)

  // Its stablemate in the same window has no modeled source and says so.
  const smiting = laneNamed(seg.procs, 'Smiting Strike')
  assert.equal(smiting.rate.sourceAmbiguous, true)
  assert.equal(smiting.rate.sourceName, undefined)
})

test('an UNKNOWN source window is assumed and LABELED, never silently assumed', { skip: missing(W43) }, () => {
  const seg = zone(W43)
  const quake = laneNamed(seg.procs, 'Earthquake')
  // Earthquake comes from a Boon of the Garou illusion, which opens no span this model tracks.
  assert.equal(quake.rate.sourceAmbiguous, true)
  assert.equal(quake.rate.sourceName, undefined)
  assert.equal(Math.round(quake.rate.sourceSec ?? -1), Math.round(seg.activeSec))
  assert.match(ppmCell(quake.rate, seg.activeSec).hint, /Assumes the source was active the whole fight/)
  assert.match(ppmCell(quake.rate, seg.activeSec).hint, /LOWER bound/)

  // The drill annotation carries the same sentence — one wording, both surfaces.
  const a = procAnnotationFor(procTagIndex(seg.procs.procSkills), 'Earthquake')
  assert.match(a?.hint ?? '', /Assumes the source was active the whole fight/)
})

test('the /100-swings figure keeps the swing denominator, whatever the source window says', { skip: missing(W35, W41) }, () => {
  const seg = zone([...W35, ...W41])
  const swings = seg.procs.overall?.swings ?? 0
  assert.ok(swings > 0)
  // Every lane divides by the SAME swing count — that denominator's whole virtue is having no
  // window ambiguity in it, and re-basing it per source would make the lanes incomparable.
  for (const l of seg.procs.lanes ?? []) {
    assert.equal(l.rate.swings, swings, `${l.name} shares the swing denominator`)
    if (l.rate.per100Swings !== undefined) {
      assert.equal(Math.round(l.rate.per100Swings * 1000), Math.round(((100 * l.count) / swings) * 1000))
    }
  }
  // The OVERALL headline is a question about the selection, so it carries no source fields at
  // all — an absence that means "not applicable", where a lane's means "unknown".
  assert.equal(seg.procs.overall?.sourceAmbiguous, undefined)
  assert.equal(seg.procs.overall?.sourceSec, undefined)
})
