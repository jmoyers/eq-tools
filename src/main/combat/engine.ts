// The combat engine: a formal state machine over the log stream.
//
// State it maintains:
//   charmed:  Set<mobName>        — your active charmed pets (name-keyed)
//   zone:     string              — current zone (resets the overall aggregate)
//   current:  Encounter | null    — the in-progress/most-recent fight
//   history:  Encounter[]         — finalized fights
//   zoneAgg:  Agg                 — damage aggregated for the whole zone
//
// Transitions (one per ingested line):
//   zone   → finalize current, reset zoneAgg
//   charm  → charmed.add(mob)     (message only the charmer sees ⇒ it's yours)
//   uncharm/death(charm spell/mob death) → charmed.delete(mob)
//   damage → route to current encounter + zoneAgg (see route())
//
// Attribution rule (damage `A → B` for N):
//   A = You            → your outgoing
//   A ∈ charmed        → your pet's outgoing (unless B is friendly)
//   B = You            → incoming
//   otherwise          → not your fight (ignored)
//
// Encounters group staggered combat: a new fight begins when there's damage and
// either none is in progress or the last one was >SEGMENT_GAP_MS ago. DPS uses
// (lastHit − firstHit), so it freezes when a fight ends.
//
// Seeding: the engine is fed the entire log on load (recording=false) so charm
// and encounter state reflect reality before the live tail (recording=true)
// takes over — this is why a pet charmed before the app opened is still tracked.

import { looksDamage, parseCombatLine, type DamageEvent } from './parse'
import type {
  ClassifiedLine,
  CombatSnapshot,
  SegmentSummary,
  SegmentView,
  SnapshotOpts,
  SourceKind,
  SourceView
} from '../../shared/combat'

interface SkillStat {
  name: string
  total: number
  hits: number
  crits: number
  max: number
}
interface SourceStat {
  name: string
  kind: SourceKind
  total: number
  hits: number
  crits: number
  bySkill: Map<string, SkillStat>
}

function addToSource(src: SourceStat, ev: DamageEvent): void {
  src.total += ev.amount
  src.hits += 1
  if (ev.crit) src.crits += 1
  const s = src.bySkill.get(ev.skill) ?? { name: ev.skill, total: 0, hits: 0, crits: 0, max: 0 }
  s.total += ev.amount
  s.hits += 1
  if (ev.crit) s.crits += 1
  s.max = Math.max(s.max, ev.amount)
  src.bySkill.set(ev.skill, s)
}

class Agg {
  out = new Map<string, SourceStat>()
  inc = new Map<string, SourceStat>()
  targets = new Map<string, number>()
  addOut(id: string, name: string, kind: SourceKind, ev: DamageEvent): void {
    const s = this.out.get(id) ?? { name, kind, total: 0, hits: 0, crits: 0, bySkill: new Map() }
    addToSource(s, ev)
    this.out.set(id, s)
  }
  addInc(name: string, ev: DamageEvent): void {
    const s = this.inc.get(name) ?? { name, kind: 'enemy' as SourceKind, total: 0, hits: 0, crits: 0, bySkill: new Map() }
    addToSource(s, ev)
    this.inc.set(name, s)
  }
  bumpTarget(name: string, amount: number): void {
    this.targets.set(name, (this.targets.get(name) ?? 0) + amount)
  }
}

interface Encounter {
  id: string
  zone?: string
  startTs: number
  lastTs: number
  agg: Agg
  engaged: Set<string>
}

const SEGMENT_GAP_MS = 10_000
const ACTIVE_MS = 3_000
const RECENT_CAP = 300

export class CombatEngine {
  private charmed = new Set<string>()
  private zone?: string
  private seq = 0
  private current: Encounter | null = null
  private history: Encounter[] = []
  private zoneAgg = new Agg()
  private zoneFinalizedMs = 0
  private recent: ClassifiedLine[] = []
  private recording = false

  /** Enable classification logging (after the historical scan, for the live tail). */
  setLive(): void {
    this.recording = true
  }

  reset(): void {
    this.charmed.clear()
    this.zone = undefined
    this.current = null
    this.history = []
    this.zoneAgg = new Agg()
    this.zoneFinalizedMs = 0
    this.recent = []
    this.recording = false
  }

  private log(ts: number, cat: string, role: ClassifiedLine['role'], text: string): void {
    if (!this.recording) return
    this.recent.push({ ts, cat, role, text })
    if (this.recent.length > RECENT_CAP) this.recent.shift()
  }

  ingest(text: string, ts: number): void {
    const ev = parseCombatLine(text, ts)
    if (!ev) {
      if (looksDamage(text)) this.log(ts, 'unparsed', 'dropped', text)
      return
    }
    if (ev.t !== 'dmg') {
      if (ev.t === 'zone') {
        this.finalizeCurrent()
        this.zone = ev.value
        this.zoneAgg = new Agg()
        this.zoneFinalizedMs = 0
        this.log(ts, 'zone', 'info', `▸ entered ${ev.value}`)
      } else if (ev.t === 'charm') {
        this.charmed.add(ev.value)
        this.log(ts, 'charm', 'info', `⚡ charmed ${ev.value}`)
      } else if (ev.t === 'uncharm') {
        this.charmed.delete(ev.value)
        this.log(ts, 'uncharm', 'info', `✕ charm broke: ${ev.value}`)
      } else {
        this.charmed.delete(ev.value)
        this.current?.engaged.delete(ev.value)
        this.log(ts, 'death', 'info', `☠ ${ev.value} died`)
      }
      return
    }
    this.route(ev)
  }

  private route(ev: DamageEvent): void {
    if (ev.amount <= 0) return
    const isYou = ev.attacker === 'You'
    const isPet = !isYou && this.charmed.has(ev.attacker)
    const friendlyAtk = isYou || isPet
    const targetIsYou = ev.target === 'You'
    const targetIsFriendly = targetIsYou || this.charmed.has(ev.target)

    const outgoing = friendlyAtk && !targetIsFriendly
    const incoming = targetIsYou && !isYou
    if (!outgoing && !incoming) return

    const enc = this.ensureEncounter(ev.ts)
    enc.lastTs = ev.ts

    const critMark = ev.crit ? '*' : ''
    if (outgoing) {
      const id = isYou ? 'you' : `pet:${ev.attacker}`
      const kind: SourceKind = isYou ? 'you' : 'pet'
      enc.agg.addOut(id, isYou ? 'You' : ev.attacker, kind, ev)
      enc.agg.bumpTarget(ev.target, ev.amount)
      this.zoneAgg.addOut(id, isYou ? 'You' : ev.attacker, kind, ev)
      this.zoneAgg.bumpTarget(ev.target, ev.amount)
      enc.engaged.add(ev.target)
      this.log(ev.ts, ev.dtype, kind, `${ev.attacker} → ${ev.target}  ${ev.amount}${critMark}  ${ev.skill}`)
    }
    if (incoming) {
      enc.agg.addInc(ev.attacker, ev)
      this.zoneAgg.addInc(ev.attacker, ev)
      enc.engaged.add(ev.attacker)
      this.log(ev.ts, ev.dtype, 'enemy', `${ev.attacker} → You  ${ev.amount}${critMark}  ${ev.skill}`)
    }
  }

  private ensureEncounter(ts: number): Encounter {
    if (this.current && ts - this.current.lastTs > SEGMENT_GAP_MS) this.finalizeCurrent()
    if (!this.current) {
      this.current = { id: `e${++this.seq}`, zone: this.zone, startTs: ts, lastTs: ts, agg: new Agg(), engaged: new Set() }
    }
    return this.current
  }

  private finalizeCurrent(): void {
    if (!this.current) return
    this.zoneFinalizedMs += Math.max(0, this.current.lastTs - this.current.startTs)
    this.history.push(this.current)
    this.current = null
  }

  snapshot(now: number, opts: SnapshotOpts = {}): CombatSnapshot {
    const combinePets = opts.combinePets ?? false
    const inCombat = !!this.current && now - this.current.lastTs < ACTIVE_MS

    const segments: SegmentSummary[] = []
    if (this.current) segments.push(this.encSummary(this.current, 'current', now))
    for (let i = this.history.length - 1; i >= 0; i--) segments.push(this.encSummary(this.history[i], 'fight', now))
    segments.push(this.zoneSummary())

    const defaultId = this.current?.id ?? this.history[this.history.length - 1]?.id ?? 'zone'
    const selectedId =
      opts.selectedId && segments.some((s) => s.id === opts.selectedId) ? opts.selectedId : defaultId
    const selected = this.buildSelected(selectedId, now, combinePets)

    const recent = (opts.showUnparsed ? this.recent : this.recent.filter((r) => r.cat !== 'unparsed')).slice(-150)
    return { selectedId, selected, segments, inCombat, zone: this.zone, charmed: [...this.charmed], recent }
  }

  private encSummary(e: Encounter, kind: 'fight' | 'current', now: number): SegmentSummary {
    const total = sumMap(e.agg.out)
    const dur = Math.max(1, (e.lastTs - e.startTs) / 1000)
    return {
      id: e.id,
      kind,
      name: encounterName(e),
      durationSec: dur,
      total,
      dps: total / dur,
      startTs: e.startTs,
      active: kind === 'current' && now - e.lastTs < ACTIVE_MS
    }
  }

  private zoneSummary(): SegmentSummary {
    const total = sumMap(this.zoneAgg.out)
    const dur = this.zoneDurationSec()
    return {
      id: 'zone',
      kind: 'zone',
      name: `${this.zone ?? 'Session'} — overall`,
      durationSec: dur,
      total,
      dps: total / dur,
      startTs: 0,
      active: false
    }
  }

  private zoneDurationSec(): number {
    const cur = this.current ? this.current.lastTs - this.current.startTs : 0
    return Math.max(1, (this.zoneFinalizedMs + cur) / 1000)
  }

  private buildSelected(id: string, now: number, combinePets: boolean): SegmentView | null {
    if (id === 'zone') {
      return this.buildView('zone', 'zone', `${this.zone ?? 'Session'} — overall`, this.zone, this.zoneAgg, this.zoneDurationSec(), false, combinePets)
    }
    const e = this.current?.id === id ? this.current : this.history.find((h) => h.id === id)
    if (!e) return null
    const dur = Math.max(1, (e.lastTs - e.startTs) / 1000)
    const active = this.current?.id === id && now - e.lastTs < ACTIVE_MS
    return this.buildView(e.id, 'fight', encounterName(e), e.zone, e.agg, dur, active, combinePets)
  }

  private buildView(
    id: string,
    kind: 'fight' | 'zone',
    name: string,
    zone: string | undefined,
    agg: Agg,
    durationSec: number,
    active: boolean,
    combinePets: boolean
  ): SegmentView {
    const entities = sourceViews(agg.out, durationSec, combinePets)
    const incoming = sourceViews(agg.inc, durationSec, false)
    const outTotal = entities.reduce((s, e) => s + e.total, 0)
    const inTotal = incoming.reduce((s, e) => s + e.total, 0)
    return {
      id,
      kind,
      name,
      zone,
      durationSec,
      active,
      outTotal,
      outDps: outTotal / durationSec,
      entities,
      inTotal,
      inDps: inTotal / durationSec,
      incoming
    }
  }
}

function sumMap(m: Map<string, SourceStat>): number {
  let t = 0
  for (const s of m.values()) t += s.total
  return t
}

function encounterName(e: Encounter): string {
  const sorted = [...e.agg.targets.entries()].sort((a, b) => b[1] - a[1])
  if (sorted.length === 0) return 'Combat'
  const top = sorted[0][0]
  return sorted.length > 1 ? `${top} +${sorted.length - 1}` : top
}

function sourceViews(map: Map<string, SourceStat>, durationSec: number, combinePets: boolean): SourceView[] {
  const merged = new Map<string, SourceStat>()
  for (const [id, s] of map) {
    if (combinePets && s.kind === 'pet') {
      const you = merged.get('you') ?? { name: 'You +pets', kind: 'you' as SourceKind, total: 0, crits: 0, hits: 0, bySkill: new Map() }
      you.name = 'You +pets'
      you.total += s.total
      you.hits += s.hits
      you.crits += s.crits
      for (const [k, sk] of s.bySkill) {
        const key = `${s.name}: ${k}`
        you.bySkill.set(key, { ...sk, name: key })
      }
      merged.set('you', you)
    } else {
      merged.set(id, s)
    }
  }
  const list = [...merged.entries()]
  const maxTotal = Math.max(1, ...list.map(([, s]) => s.total))
  return list
    .map(([id, s]) => {
      const skMax = Math.max(1, ...[...s.bySkill.values()].map((k) => k.total))
      return {
        id,
        name: s.name,
        kind: s.kind,
        total: s.total,
        dps: s.total / durationSec,
        pct: (s.total / maxTotal) * 100,
        hits: s.hits,
        crits: s.crits,
        critPct: s.hits ? (s.crits / s.hits) * 100 : 0,
        skills: [...s.bySkill.values()]
          .sort((a, b) => b.total - a.total)
          .slice(0, 12)
          .map((k) => ({ name: k.name, total: k.total, pct: (k.total / skMax) * 100, hits: k.hits, crits: k.crits, max: k.max }))
      }
    })
    .sort((a, b) => b.total - a.total)
}
