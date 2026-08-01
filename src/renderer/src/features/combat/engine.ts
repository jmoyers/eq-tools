// Combat parsing + a live DPS engine with charm/pet attribution.
//
// The hard problem in EQ: the log identifies actors by NAME only (no ids, no
// team). We accurately attribute You + your charmed pets by anchoring on "You"
// and "<mob> has been charmed" (a message only the charmer sees). Other named
// sources are tracked but flagged "unverified" because we can't know their pets
// or whether a mob is their charm. Charm windows gate a mob's damage: while it's
// your charmed pet its damage-to-enemies is yours; once charm wears off (or it
// dies) it reverts to an enemy.

export type DamageKind = 'melee' | 'spell' | 'dot'

interface DamageEvent {
  kind: 'damage'
  ts: number
  attacker: string
  target: string
  amount: number
  ability: string
  dtype: DamageKind
}
interface CharmEvent { kind: 'charm' | 'uncharm' | 'death'; mob: string }
type CombatEvent = DamageEvent | CharmEvent | null

const MELEE_VERBS =
  'hits?|slashes?|pierces?|crushes?|bashes?|kicks?|bites?|claws?|gores?|mauls?|punches?|strikes?|slices?|backstabs?|slams?|stings?|rends?|smashes?|gnaws?|lashes?'

const MELEE_RE = new RegExp(`^(.+?) (?:${MELEE_VERBS}) (.+?) for (\\d+) points? of damage`)
const SPELL_HIT_RE = /^(.+?) (?:hits?) (.+?) for (\d+) points of \w+ damage by (.+?)\.?( \(.*\))?$/
const DOT_RE = /^(.+?) has taken (\d+) damage from (.+?)\.$/
const CHARM_RE = /^(.+?) has been charmed\.$/
const UNCHARM_RE = /^Your (.+?) spell has worn off of (.+?)\.$/
const SLAIN_BY_RE = /^(.+?) has been slain by .+?!$/
const SLAIN_YOU_RE = /^You have slain (.+?)!$/
const CHARM_SPELL_RE = /charm|beguile|allure|cajole|dictate|besiege|agacerie|enthrall|beckon|command of druzzil|dominate|boltran/i

function norm(name: string): string {
  const n = name.trim()
  if (n === 'YOU' || n === 'You' || n === 'you' || n === 'yourself') return 'You'
  return n
}

export function parseCombatLine(text: string, ts: number): CombatEvent {
  // charm lifecycle first (cheap checks)
  let m = CHARM_RE.exec(text)
  if (m) return { kind: 'charm', mob: norm(m[1]) }
  m = UNCHARM_RE.exec(text)
  if (m && CHARM_SPELL_RE.test(m[1])) return { kind: 'uncharm', mob: norm(m[2]) }
  m = SLAIN_YOU_RE.exec(text)
  if (m) return { kind: 'death', mob: norm(m[1]) }
  m = SLAIN_BY_RE.exec(text)
  if (m) return { kind: 'death', mob: norm(m[1]) }

  // spell direct damage: "You hit X for N points of magic damage by Spell."
  m = SPELL_HIT_RE.exec(text)
  if (m) {
    return {
      kind: 'damage',
      ts,
      attacker: norm(m[1]),
      target: norm(m[2]),
      amount: Number(m[3]),
      ability: m[4].trim(),
      dtype: 'spell'
    }
  }
  // DoT: "X has taken N damage from your Spell." | "... from Spell by Caster."
  m = DOT_RE.exec(text)
  if (m) {
    const target = norm(m[1])
    const amount = Number(m[2])
    const rest = m[3]
    let attacker = '?'
    let ability = rest
    if (/^your /i.test(rest)) {
      attacker = 'You'
      ability = rest.replace(/^your /i, '')
    } else {
      const by = / by (.+)$/.exec(rest)
      if (by) {
        attacker = norm(by[1])
        ability = rest.slice(0, by.index)
      }
    }
    if (attacker === '?') return null
    return { kind: 'damage', ts, attacker, target, amount, ability: ability.trim(), dtype: 'dot' }
  }
  // melee: "X crushes Y for N points of damage."
  m = MELEE_RE.exec(text)
  if (m) {
    return {
      kind: 'damage',
      ts,
      attacker: norm(m[1]),
      target: norm(m[2]),
      amount: Number(m[3]),
      ability: 'Melee',
      dtype: 'melee'
    }
  }
  return null
}

// ----- engine -----

export type EntityKind = 'you' | 'pet' | 'other'

interface EntityAgg {
  name: string
  kind: EntityKind
  total: number
  abilities: Map<string, number>
}

interface Scope {
  entities: Map<string, EntityAgg> // outgoing, keyed by id
  incoming: Map<string, number> // damage to You, by attacker
  enemyDmg: Map<string, number> // for target label
}

function newScope(): Scope {
  return { entities: new Map(), incoming: new Map(), enemyDmg: new Map() }
}

export interface EntitySnap {
  id: string
  name: string
  kind: EntityKind
  total: number
  dps: number
  pct: number
  abilities: { name: string; total: number }[]
}
export interface IncomingSnap {
  name: string
  total: number
  dps: number
  pct: number
}
export interface ScopeSnap {
  durationSec: number
  total: number
  dps: number
  entities: EntitySnap[]
  incoming: IncomingSnap[]
  incomingTotal: number
}
export interface CombatSnapshot {
  fight: ScopeSnap & { target: string; active: boolean }
  overall: ScopeSnap
}

const GAP_MS = 12_000 // idle gap that ends a fight

export class CombatEngine {
  private charmed = new Set<string>()
  private fStart = 0
  private fLast = 0
  private fTarget = ''
  private fight = newScope()
  private combatMs = 0
  private overall = newScope()

  reset(): void {
    this.charmed.clear()
    this.fStart = this.fLast = 0
    this.fTarget = ''
    this.fight = newScope()
    this.combatMs = 0
    this.overall = newScope()
  }

  private foldFight(): void {
    if (!this.fStart) return
    this.combatMs += Math.max(0, this.fLast - this.fStart)
    for (const [id, e] of this.fight.entities) {
      const o = this.overall.entities.get(id) ?? { name: e.name, kind: e.kind, total: 0, abilities: new Map() }
      o.total += e.total
      for (const [a, v] of e.abilities) o.abilities.set(a, (o.abilities.get(a) ?? 0) + v)
      this.overall.entities.set(id, o)
    }
    for (const [k, v] of this.fight.incoming) this.overall.incoming.set(k, (this.overall.incoming.get(k) ?? 0) + v)
    this.fight = newScope()
    this.fStart = this.fLast = 0
    this.fTarget = ''
  }

  ingest(text: string, ts: number): void {
    const ev = parseCombatLine(text, ts)
    if (!ev) return
    if (ev.kind !== 'damage') {
      if (ev.kind === 'charm') this.charmed.add(ev.mob)
      else this.charmed.delete(ev.mob) // uncharm or death
      return
    }
    // damage
    if (ev.amount <= 0) return
    if (this.fLast && ts - this.fLast > GAP_MS) this.foldFight()
    if (!this.fStart) this.fStart = ts
    this.fLast = ts

    const isYou = ev.attacker === 'You'
    const isPet = !isYou && this.charmed.has(ev.attacker)
    const targetIsYou = ev.target === 'You'
    const targetIsFriendly = targetIsYou || this.charmed.has(ev.target)

    // Outgoing (friendly damage to enemies)
    if (isYou || isPet) {
      if (!targetIsFriendly) {
        const id = isYou ? 'you' : `pet:${ev.attacker}`
        this.addOut(id, isYou ? 'You' : ev.attacker, isYou ? 'you' : 'pet', ev.ability, ev.amount)
        this.bumpEnemy(ev.target, ev.amount)
      }
    } else if (!targetIsFriendly) {
      // Unverified other source damaging a non-friendly target.
      this.addOut(`other:${ev.attacker}`, ev.attacker, 'other', ev.ability, ev.amount)
    }

    // Incoming (anything damaging You)
    if (targetIsYou && !isYou) {
      this.fight.incoming.set(ev.attacker, (this.fight.incoming.get(ev.attacker) ?? 0) + ev.amount)
    }
  }

  private addOut(id: string, name: string, kind: EntityKind, ability: string, amount: number): void {
    const e = this.fight.entities.get(id) ?? { name, kind, total: 0, abilities: new Map() }
    e.total += amount
    e.abilities.set(ability, (e.abilities.get(ability) ?? 0) + amount)
    this.fight.entities.set(id, e)
  }

  private bumpEnemy(target: string, amount: number): void {
    const v = (this.fight.enemyDmg.get(target) ?? 0) + amount
    this.fight.enemyDmg.set(target, v)
    if (!this.fTarget || v > (this.fight.enemyDmg.get(this.fTarget) ?? 0)) this.fTarget = target
  }

  snapshot(now: number, combinePets: boolean, showOthers: boolean): CombatSnapshot {
    const active = this.fLast > 0 && now - this.fLast <= GAP_MS
    const fightDur = this.fStart ? Math.max(1, ((active ? now : this.fLast) - this.fStart) / 1000) : 0
    const fight = this.buildScope(this.fight, fightDur, combinePets, showOthers)

    // overall = finished fights + current fight
    const merged = newScope()
    for (const scope of [this.overall, this.fight]) {
      for (const [id, e] of scope.entities) {
        const m = merged.entities.get(id) ?? { name: e.name, kind: e.kind, total: 0, abilities: new Map() }
        m.total += e.total
        for (const [a, v] of e.abilities) m.abilities.set(a, (m.abilities.get(a) ?? 0) + v)
        merged.entities.set(id, m)
      }
      for (const [k, v] of scope.incoming) merged.incoming.set(k, (merged.incoming.get(k) ?? 0) + v)
    }
    const overallDur = Math.max(1, (this.combatMs + (this.fStart ? (active ? now : this.fLast) - this.fStart : 0)) / 1000)
    const overall = this.buildScope(merged, overallDur, combinePets, showOthers)

    return {
      fight: { ...fight, target: this.fTarget || (active ? '…' : 'No target'), active },
      overall
    }
  }

  private buildScope(scope: Scope, durationSec: number, combinePets: boolean, showOthers: boolean): ScopeSnap {
    // optionally merge pets into You
    const ents = new Map<string, EntityAgg>()
    for (const [id, e] of scope.entities) {
      if (combinePets && e.kind === 'pet') {
        const you = ents.get('you') ?? { name: 'You +pets', kind: 'you', total: 0, abilities: new Map() }
        you.name = 'You +pets'
        you.total += e.total
        for (const [a, v] of e.abilities) you.abilities.set(`(pet) ${e.name}: ${a}`, (you.abilities.get(`(pet) ${e.name}: ${a}`) ?? 0) + v)
        ents.set('you', you)
      } else {
        ents.set(id, { ...e, abilities: new Map(e.abilities) })
      }
    }
    let list = [...ents.entries()].map(([id, e]) => ({ id, ...e }))
    if (!showOthers) list = list.filter((e) => e.kind !== 'other')
    // friendly total = you + pets (exclude 'other' from the headline total)
    const friendlyTotal = list.filter((e) => e.kind !== 'other').reduce((s, e) => s + e.total, 0)
    const max = Math.max(1, ...list.map((e) => e.total))
    list.sort((a, b) => b.total - a.total)
    const entities: EntitySnap[] = list.map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      total: e.total,
      dps: e.total / durationSec,
      pct: (e.total / max) * 100,
      abilities: [...e.abilities.entries()]
        .map(([name, total]) => ({ name, total }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 12)
    }))

    const incomingTotal = [...scope.incoming.values()].reduce((s, v) => s + v, 0)
    const inMax = Math.max(1, ...scope.incoming.values())
    const incoming: IncomingSnap[] = [...scope.incoming.entries()]
      .map(([name, total]) => ({ name, total, dps: total / durationSec, pct: (total / inMax) * 100 }))
      .sort((a, b) => b.total - a.total)

    return {
      durationSec,
      total: friendlyTotal,
      dps: friendlyTotal / durationSec,
      entities,
      incoming,
      incomingTotal
    }
  }
}
