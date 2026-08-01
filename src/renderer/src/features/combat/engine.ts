// A tight combat data model + engine. Public API:
//   const eng = new CombatEngine()
//   eng.ingest(text, ts)              // feed each parsed log line
//   eng.snapshot(now, { combinePets, selectedId })  // pull a view for the UI
//
// Combat is scoped to YOU: an encounter starts when you or your pet deal/take
// damage and groups all activity until an idle gap (staggered adds join the same
// encounter). Encounters are recorded to history; the "zone overall" aggregate
// resets when you zone. DPS uses (last hit − first hit), so it never decays after
// a fight ends.

import { parseCombatLine, type DamageEvent } from './parse'

export type SourceKind = 'you' | 'pet' | 'enemy'

export interface SkillStat {
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
  out = new Map<string, SourceStat>() // friendly (you + pets), keyed by id
  inc = new Map<string, SourceStat>() // damage to you, keyed by attacker
  targets = new Map<string, number>() // damage dealt to each enemy

  addOut(id: string, name: string, kind: SourceKind, ev: DamageEvent): void {
    const s = this.out.get(id) ?? { name, kind, total: 0, hits: 0, crits: 0, bySkill: new Map() }
    addToSource(s, ev)
    this.out.set(id, s)
  }
  addInc(name: string, ev: DamageEvent): void {
    const s = this.inc.get(name) ?? { name, kind: 'enemy', total: 0, hits: 0, crits: 0, bySkill: new Map() }
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

// ---- snapshot view types (the UI contract) ----

export interface SkillView {
  name: string
  total: number
  pct: number
  hits: number
  crits: number
  max: number
}
export interface SourceView {
  id: string
  name: string
  kind: SourceKind
  total: number
  dps: number
  pct: number
  hits: number
  crits: number
  critPct: number
  skills: SkillView[]
}
export interface SegmentView {
  id: string
  kind: 'fight' | 'zone'
  name: string
  zone?: string
  durationSec: number
  active: boolean
  outTotal: number
  outDps: number
  entities: SourceView[]
  inTotal: number
  inDps: number
  incoming: SourceView[]
}
export interface SegmentSummary {
  id: string
  kind: 'fight' | 'zone' | 'current'
  name: string
  durationSec: number
  total: number
  dps: number
  startTs: number
  active: boolean
}
export interface CombatSnapshot {
  selectedId: string
  selected: SegmentView | null
  segments: SegmentSummary[]
  inCombat: boolean
  zone?: string
}

export interface SnapshotOpts {
  combinePets?: boolean
  selectedId?: string
}

const SEGMENT_GAP_MS = 10_000
const ACTIVE_MS = 3_000

export class CombatEngine {
  private charmed = new Set<string>()
  private zone?: string
  private seq = 0
  private current: Encounter | null = null
  private history: Encounter[] = []
  private zoneAgg = new Agg()
  private zoneFinalizedMs = 0

  reset(): void {
    this.charmed.clear()
    this.current = null
    this.history = []
    this.zoneAgg = new Agg()
    this.zoneFinalizedMs = 0
  }

  ingest(text: string, ts: number): void {
    const ev = parseCombatLine(text, ts)
    if (!ev) return
    if (ev.t !== 'dmg') {
      if (ev.t === 'zone') {
        this.finalizeCurrent()
        this.zone = ev.value
        this.zoneAgg = new Agg()
        this.zoneFinalizedMs = 0
      } else if (ev.t === 'charm') {
        this.charmed.add(ev.value)
      } else if (ev.t === 'uncharm') {
        this.charmed.delete(ev.value)
      } else {
        // death
        this.charmed.delete(ev.value)
        this.current?.engaged.delete(ev.value)
      }
      return
    }
    // ev is a DamageEvent
    if (ev.amount <= 0) return
    const isYou = ev.attacker === 'You'
    const isPet = !isYou && this.charmed.has(ev.attacker)
    const friendlyAtk = isYou || isPet
    const targetIsYou = ev.target === 'You'
    const targetIsFriendly = targetIsYou || this.charmed.has(ev.target)

    const outgoing = friendlyAtk && !targetIsFriendly
    const incoming = targetIsYou && !isYou
    if (!outgoing && !incoming) return // not your fight

    const enc = this.ensureEncounter(ts)
    enc.lastTs = ts

    if (outgoing) {
      const id = isYou ? 'you' : `pet:${ev.attacker}`
      const kind: SourceKind = isYou ? 'you' : 'pet'
      enc.agg.addOut(id, isYou ? 'You' : ev.attacker, kind, ev)
      enc.agg.bumpTarget(ev.target, ev.amount)
      this.zoneAgg.addOut(id, isYou ? 'You' : ev.attacker, kind, ev)
      this.zoneAgg.bumpTarget(ev.target, ev.amount)
      enc.engaged.add(ev.target)
    }
    if (incoming) {
      enc.agg.addInc(ev.attacker, ev)
      this.zoneAgg.addInc(ev.attacker, ev)
      enc.engaged.add(ev.attacker)
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

  // ---- snapshot ----

  snapshot(now: number, opts: SnapshotOpts = {}): CombatSnapshot {
    const combinePets = opts.combinePets ?? false
    const inCombat = !!this.current && now - this.current.lastTs < ACTIVE_MS

    // segment summaries: current (if any) + history (newest first) + zone overall
    const segments: SegmentSummary[] = []
    if (this.current) segments.push(this.encSummary(this.current, 'current', now))
    for (let i = this.history.length - 1; i >= 0; i--) segments.push(this.encSummary(this.history[i], 'fight', now))
    segments.push(this.zoneSummary())

    const defaultId = this.current?.id ?? this.history[this.history.length - 1]?.id ?? 'zone'
    const selectedId =
      opts.selectedId && segments.some((s) => s.id === opts.selectedId) ? opts.selectedId : defaultId

    const selected = this.buildSelected(selectedId, now, combinePets)
    return { selectedId, selected, segments, inCombat, zone: this.zone }
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
  // optionally merge pets into You
  const merged = new Map<string, SourceStat>()
  for (const [id, s] of map) {
    if (combinePets && s.kind === 'pet') {
      const you = merged.get('you') ?? { name: 'You +pets', kind: 'you', total: 0, crits: 0, hits: 0, bySkill: new Map() }
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
          .map((k) => ({
            name: k.name,
            total: k.total,
            pct: (k.total / skMax) * 100,
            hits: k.hits,
            crits: k.crits,
            max: k.max
          }))
      }
    })
    .sort((a, b) => b.total - a.total)
}
